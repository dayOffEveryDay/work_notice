using System.Net;
using WorkNoticeAgent.Core;
using WorkNoticeAgent.Core.Cloud;

// Test-only proxy: production still requires HTTPS. Only this probe translates the
// logical HTTPS origin to an ephemeral loopback workerd server. Keys stay in memory.
var secret = Environment.GetEnvironmentVariable("WORK_NOTICE_TEST_SECRET") ?? throw new InvalidOperationException("Missing ephemeral test key");
var address = new Uri(Environment.GetEnvironmentVariable("WORK_NOTICE_TEST_ENDPOINT") ?? throw new InvalidOperationException("Missing loopback endpoint"));
if (!address.IsLoopback || address.Scheme != "http") throw new InvalidOperationException("Probe endpoint must be loopback HTTP");
using var handler = new LoopbackProxy(address);
using var http = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
var clock = new SystemClock();
var status = new AgentStatus(AgentMode.Standby, NotificationAccess.Allowed, ListenerHealth.Ready, null, null, clock.UtcNow, TelegramSourceConfirmed: true);
var heartbeat = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
var delivered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
DateTimeOffset? lastAlert = null;
await using var cloud = new CloudAgentService(new(http, clock, new NoDelay(), () => 0), new Local(), () => Volatile.Read(ref status), clock, "integration-probe");
cloud.Configure(new("https://worker.test", "home-windows", secret));
cloud.Changed += () =>
{
    var current = cloud.GetStatus();
    if (current.LastHeartbeatUtc is not null) heartbeat.TrySetResult();
    if (current.LastAlertUtc is not null && current.LastAlertUtc != lastAlert) { lastAlert = current.LastAlertUtc; delivered.TrySetResult(); }
};
cloud.Start();
await heartbeat.Task.WaitAsync(TimeSpan.FromSeconds(10));
Volatile.Write(ref status, status with { Mode = AgentMode.Monitoring });
foreach (var (source, aumid) in new[] { ("TELEGRAM", "Telegram.TelegramDesktop"), ("LARK_A_CHROME", "synthetic.chrome.lark"), ("LARK_B_BRAVE", "synthetic.brave.lark") })
{
    delivered = new(TaskCreationOptions.RunContinuationsAsynchronously);
    await cloud.DispatchAsync(new(Guid.NewGuid(), source, aumid, 42, clock.UtcNow, clock.UtcNow, "probe"), CancellationToken.None);
    await delivered.Task.WaitAsync(TimeSpan.FromSeconds(10));
}
if (handler.AlertAttempts != 6) throw new InvalidOperationException("Expected one lost-ack retry per source");
await cloud.StopAsync();
if (cloud.GetStatus().Message != "已回報正常退出") throw new InvalidOperationException("Stop was not confirmed");
Console.WriteLine("PASS: three-source production C# signing/pipeline -> local Worker/D1, lost-ack retry and STOPPED_BY_USER confirmed.");

sealed class NoDelay : IAsyncDelay { public Task DelayAsync(TimeSpan delay, CancellationToken token) => Task.CompletedTask; }
sealed class Local : IAlertDispatcher { public Task DispatchAsync(WorkAlertEvent alert, CancellationToken token) => Task.CompletedTask; }
sealed class LoopbackProxy(Uri endpoint) : HttpMessageHandler
{
    private readonly HttpClient _inner = new(new HttpClientHandler { AllowAutoRedirect = false });
    public int AlertAttempts { get; private set; }
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
        var path = request.RequestUri!.AbsolutePath;
        using var forwarded = new HttpRequestMessage(request.Method, new Uri(endpoint, path));
        foreach (var header in request.Headers) forwarded.Headers.TryAddWithoutValidation(header.Key, header.Value);
        forwarded.Content = new ByteArrayContent(await request.Content!.ReadAsByteArrayAsync(token));
        foreach (var header in request.Content.Headers) forwarded.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);
        var response = await _inner.SendAsync(forwarded, token);
        if (path == "/api/alert" && ++AlertAttempts % 2 == 1 && response.IsSuccessStatusCode)
        {
            response.Dispose(); // Simulates server commit followed by lost acknowledgement.
            return new(HttpStatusCode.ServiceUnavailable);
        }
        return response;
    }
    protected override void Dispose(bool disposing) { if (disposing) _inner.Dispose(); base.Dispose(disposing); }
}
