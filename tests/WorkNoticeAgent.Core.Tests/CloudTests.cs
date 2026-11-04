using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using WorkNoticeAgent.Core;
using WorkNoticeAgent.Core.Cloud;
using Xunit;

namespace WorkNoticeAgent.Core.Tests;

public sealed class CloudTests
{
    private static CloudOptions Options() => new("https://worker.example", "home-windows", Convert.ToHexString(RandomNumberGenerator.GetBytes(32)));
    private static WorkAlertEvent Alert(IClock clock) => new(Guid.NewGuid(), "TELEGRAM", "Telegram.TelegramDesktop", 42, clock.UtcNow, clock.UtcNow, "local-key");
    private static AgentStatus Status(IClock clock, AgentMode mode = AgentMode.Monitoring) => new(mode, NotificationAccess.Allowed, ListenerHealth.Ready, null, null, clock.UtcNow, TelegramSourceConfirmed: true);

    [Fact]
    public void SignatureUsesExactUtf8BodyAndSpecifiedCanonicalFields()
    {
        var options = Options();
        var bytes = Encoding.UTF8.GetBytes("{\"value\":\"台灣\"}");
        var canonical = "POST\n/api/alert\nhome-windows\n1793600000\nnonce-1234567890123456\n" + Convert.ToHexStringLower(SHA256.HashData(bytes));
        var expected = "v1=" + Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(options.Secret), Encoding.UTF8.GetBytes(canonical)));
        Assert.Equal(expected, RequestSigning.Sign("post", "/api/alert", options.DeviceId, "1793600000", "nonce-1234567890123456", bytes, options.Secret));
        Assert.DoesNotContain(options.Secret, options.ToString());
    }
    [Fact]
    public void WireEventIdIsStableAcrossRetriesRestartAndTimezoneRepresentation()
    {
        var clock = new Clock();
        var alert = Alert(clock);
        var first = RequestSigning.EventId(alert, "home-windows");
        Assert.Equal(64, first.Length);
        Assert.Equal(first, RequestSigning.EventId(alert with { EventId = Guid.NewGuid(), DetectedAtUtc = clock.UtcNow.AddMinutes(1), CreatedAtUtc = clock.UtcNow.ToOffset(TimeSpan.FromHours(8)) }, "home-windows"));
        Assert.NotEqual(first, RequestSigning.EventId(alert with { WindowsNotificationId = 43 }, "home-windows"));
        Assert.NotEqual(first, RequestSigning.EventId(alert with { CreatedAtUtc = clock.UtcNow.AddTicks(1) }, "home-windows"));
        Assert.NotEqual(first, RequestSigning.EventId(alert, "other-windows"));
    }
    [Fact]
    public async Task RetryKeepsEventBodyAndIdButRenewsNonceTimestampAndSignature()
    {
        var clock = new Clock();
        var delay = new Delay(clock);
        using var handler = new Handler((count, _, _) => Task.FromResult(Response(count < 4 ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.Accepted, "ACCEPTED")));
        using var client = new HttpClient(handler);
        var transport = new CloudTransport(client, clock, delay, () => 0);
        var options = Options();
        Assert.True((await transport.AlertAsync(options, Alert(clock), () => true, CancellationToken.None)).Success);
        Assert.Equal(new[] { 2d, 5d, 15d }, delay.Waits.Select(time => time.TotalSeconds));
        var requests = handler.Requests.ToArray();
        Assert.Equal(4, requests.Length);
        Assert.All(requests, request => Assert.Equal(requests[0].Body, request.Body));
        Assert.Equal(4, requests.Select(request => request.Headers["X-Nonce"]).Distinct().Count());
        Assert.Equal(4, requests.Select(request => request.Headers["X-Timestamp"]).Distinct().Count());
        foreach (var request in requests)
            Assert.Equal(RequestSigning.Sign("POST", "/api/alert", options.DeviceId, request.Headers["X-Timestamp"], request.Headers["X-Nonce"], request.Body, options.Secret), request.Headers["X-Signature"]);
        using var body = JsonDocument.Parse(requests[0].Body);
        Assert.EndsWith("Z", body.RootElement.GetProperty("occurredAt").GetString());
        Assert.Equal(new[] { "eventId", "deviceId", "source", "aumid", "notificationId", "occurredAt" }, body.RootElement.EnumerateObject().Select(p => p.Name));
    }
    [Theory]
    [InlineData(400)] [InlineData(401)] [InlineData(403)] [InlineData(409)]
    public async Task AuthenticationAndValidationFailuresAreNotRetried(int status)
    {
        var clock = new Clock();
        var delay = new Delay(clock);
        using var handler = new Handler((_, _, _) => Task.FromResult(Response((HttpStatusCode)status, "private-server-message")));
        using var client = new HttpClient(handler);
        var result = await new CloudTransport(client, clock, delay).AlertAsync(Options(), Alert(clock), () => true, CancellationToken.None);
        Assert.False(result.Success);
        Assert.Equal("HTTP_" + status, result.Code);
        Assert.Single(handler.Requests);
        Assert.Empty(delay.Waits);
    }
    [Fact]
    public async Task NetworkFailureRetriesAndExpiredEventStopsBeforeNextAttempt()
    {
        var clock = new Clock();
        var created = clock.UtcNow;
        var delay = new Delay(clock, 121);
        using var handler = new Handler((_, _, _) => throw new HttpRequestException());
        using var client = new HttpClient(handler);
        var result = await new CloudTransport(client, clock, delay).AlertAsync(Options(), Alert(clock), () => clock.UtcNow - created <= TimeSpan.FromSeconds(120), CancellationToken.None);
        Assert.Equal("DROPPED", result.Code);
        Assert.Single(handler.Requests);
    }
    [Fact]
    public async Task CallerCancellationBoundsAnUnresponsiveHttpHandler()
    {
        var clock = new Clock();
        using var handler = new Handler((_, _, _) => new TaskCompletionSource<HttpResponseMessage>().Task);
        using var client = new HttpClient(handler);
        using var timeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => new CloudTransport(client, clock, new Delay(clock)).AlertAsync(Options(), Alert(clock), () => true, timeout.Token));
        Assert.Single(handler.Requests);
    }
    [Fact]
    public async Task StandbyHeartbeatIncludesHealthAndStopDoesNotRetry()
    {
        var clock = new Clock();
        var delay = new Delay(clock);
        using var handler = new Handler((_, _, _) => Task.FromResult(Response(HttpStatusCode.ServiceUnavailable, "error")));
        using var client = new HttpClient(handler);
        var result = await new CloudTransport(client, clock, delay).HeartbeatAsync(Options(), Status(clock, AgentMode.Standby), "session", "1.0", true, CancellationToken.None);
        Assert.False(result.Success);
        Assert.Empty(delay.Waits);
        using var body = JsonDocument.Parse(Assert.Single(handler.Requests).Body);
        Assert.Equal("STOPPED_BY_USER", body.RootElement.GetProperty("agentMode").GetString());
        Assert.True(body.RootElement.GetProperty("telegramSourceConfirmed").GetBoolean());
        Assert.Equal("ALLOWED", body.RootElement.GetProperty("notificationPermission").GetString());
    }
    [Fact]
    public async Task QueueIsBoundedAndDispatchNeverWaitsForNetwork()
    {
        var clock = new Clock();
        using var handler = new Handler((_, _, _) => throw new InvalidOperationException());
        using var client = new HttpClient(handler);
        var local = new Local();
        await using var service = new CloudAgentService(new(client, clock, new Delay(clock)), local, () => Status(clock), clock, "1.0", capacity: 2);
        service.Configure(Options());
        await service.DispatchAsync(Alert(clock), CancellationToken.None);
        await service.DispatchAsync(Alert(clock), CancellationToken.None);
        await service.DispatchAsync(Alert(clock), CancellationToken.None);
        Assert.Equal(3, local.Count);
        Assert.Contains("佇列已滿", service.GetStatus().Message);
        Assert.Empty(handler.Requests); // pump not started; dispatch still completed immediately
    }
    [Fact]
    public async Task StartupAndPeriodicHeartbeatContinueInStandbyAndStopIsConfirmed()
    {
        var clock = new Clock();
        var twice = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var handler = new Handler((count, _, _) => { if (count >= 2) twice.TrySetResult(); return Task.FromResult(Response(HttpStatusCode.OK, "ok")); });
        using var client = new HttpClient(handler);
        await using var service = new CloudAgentService(new(client, clock, new Delay(clock)), new Local(), () => Status(clock, AgentMode.Standby), clock, "1.0", TimeSpan.FromMilliseconds(30));
        service.Configure(Options());
        service.Start();
        await twice.Task.WaitAsync(TimeSpan.FromSeconds(3));
        await service.StopAsync();
        var messages = handler.Requests.ToArray().Select(request => JsonDocument.Parse(request.Body).RootElement.GetProperty("agentMode").GetString()).ToArray();
        Assert.Equal("STANDBY", messages[0]);
        Assert.Equal("STANDBY", messages[1]);
        Assert.Equal("STOPPED_BY_USER", messages[^1]);
        Assert.NotNull(service.GetStatus().LastHeartbeatUtc);
        Assert.Equal("已回報正常退出", service.GetStatus().Message);
    }
    [Fact]
    public async Task StandbyDropsQueuedAlertsAndPauseSuppressesHeartbeatUntilResume()
    {
        var clock = new Clock();
        var dropped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var handler = new Handler((_, _, _) => Task.FromResult(Response(HttpStatusCode.OK, "ok")));
        using var client = new HttpClient(handler);
        var current = Status(clock);
        await using var service = new CloudAgentService(new(client, clock, new Delay(clock)), new Local(), () => current, clock, "1.0");
        service.Configure(Options());
        service.Changed += () => { if (service.GetStatus().Message.Contains("DROPPED")) dropped.TrySetResult(); };
        service.Pause();
        await service.HeartbeatOnceAsync();
        Assert.Empty(handler.Requests);
        await service.ResumeAsync();
        await service.DispatchAsync(Alert(clock), CancellationToken.None);
        current = Status(clock, AgentMode.Standby);
        service.Start();
        await dropped.Task.WaitAsync(TimeSpan.FromSeconds(3));
        Assert.All(handler.Requests, request => Assert.Equal("/api/heartbeat", request.Path));
        Assert.NotNull(service.GetStatus().LastHeartbeatUtc);
    }
    [Fact]
    public async Task PauseCancelsInflightHeartbeatAndRequiresExplicitResume()
    {
        var clock = new Clock();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var handler = new Handler((count, _, _) =>
        {
            if (count == 1) { entered.TrySetResult(); return new TaskCompletionSource<HttpResponseMessage>().Task; }
            return Task.FromResult(Response(HttpStatusCode.OK, "ok"));
        });
        using var client = new HttpClient(handler);
        await using var service = new CloudAgentService(new(client, clock, new Delay(clock)), new Local(), () => Status(clock), clock, "1.0");
        service.Configure(Options());
        var heartbeat = service.HeartbeatOnceAsync();
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(3));
        service.Pause();
        await heartbeat.WaitAsync(TimeSpan.FromSeconds(1));
        await service.HeartbeatOnceAsync();
        Assert.Single(handler.Requests);
        Assert.Null(service.GetStatus().LastHeartbeatUtc);
        await service.ResumeAsync();
        Assert.Equal(2, handler.Requests.Count);
        Assert.NotNull(service.GetStatus().LastHeartbeatUtc);
    }
    [Fact]
    public async Task UnresponsiveShutdownIsBoundedAndNeverClaimsConfirmedStop()
    {
        var clock = new Clock();
        var first = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var handler = new Handler((_, _, _) => { first.TrySetResult(); return new TaskCompletionSource<HttpResponseMessage>().Task; });
        using var client = new HttpClient(handler);
        await using var service = new CloudAgentService(new(client, clock, new Delay(clock)), new Local(), () => Status(clock), clock, "1.0");
        service.Configure(Options());
        service.Start();
        await first.Task.WaitAsync(TimeSpan.FromSeconds(3));
        await service.StopAsync().WaitAsync(TimeSpan.FromSeconds(3));
        Assert.Contains("退出回報未確認", service.GetStatus().Message);
        Assert.Null(service.GetStatus().LastHeartbeatUtc);
    }
    [Fact]
    public async Task OldConnectionAcknowledgementCannotMarkNewConfigurationConnected()
    {
        var clock = new Clock();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var reply = new TaskCompletionSource<HttpResponseMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var handler = new Handler((count, _, _) =>
        {
            if (count == 1) { entered.TrySetResult(); return reply.Task; }
            return Task.FromResult(Response(HttpStatusCode.OK, "ok"));
        });
        using var client = new HttpClient(handler);
        await using var service = new CloudAgentService(new(client, clock, new Delay(clock)), new Local(), () => Status(clock), clock, "1.0");
        service.Configure(Options());
        var oldRequest = service.HeartbeatOnceAsync();
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(3));
        service.Configure(Options());
        reply.SetResult(Response(HttpStatusCode.OK, "ok"));
        await oldRequest;
        Assert.Null(service.GetStatus().LastHeartbeatUtc);
        Assert.Contains("等待心跳確認", service.GetStatus().Message);
        await service.HeartbeatOnceAsync();
        Assert.NotNull(service.GetStatus().LastHeartbeatUtc);
    }
    [Theory]
    [InlineData("http://worker.example")] [InlineData("https://worker.example/path")]
    [InlineData("https://worker.example?token=abc")] [InlineData("https://user:pass@worker.example")]
    public void EndpointMustBeAnHttpsOrigin(string endpoint) => Assert.Throws<ArgumentException>(() => new CloudOptions(endpoint, "home-windows", Options().Secret));

    [Theory]
    [InlineData("LARK_A_CHROME")]
    [InlineData("LARK_B_BRAVE")]
    public async Task BrowserEventsUseSignedCloudPipelineWithoutTelegramRelabeling(string source)
    {
        var clock = new Clock();
        using var handler = new Handler((_, request, _) => Task.FromResult(Response(HttpStatusCode.OK, request.RequestUri!.AbsolutePath == "/api/alert" ? "ACCEPTED" : "ok")));
        using var client = new HttpClient(handler);
        var local = new Local();
        var transport = new CloudTransport(client, clock, new Delay(clock));
        await using var service = new CloudAgentService(transport, local, () => Status(clock), clock, "test");
        service.Configure(Options());
        var alert = Alert(clock) with { Source = source, SourceAppId = "synthetic-browser" };
        await service.DispatchAsync(alert, CancellationToken.None);
        Assert.Equal(1, local.Count);
        var delivered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        service.Changed += () => { if (service.GetStatus().LastAlertUtc is not null) delivered.TrySetResult(); };
        service.Start();
        await delivered.Task.WaitAsync(TimeSpan.FromSeconds(3));
        using var body = JsonDocument.Parse(Assert.Single(handler.Requests, r => r.Path == "/api/alert").Body);
        Assert.Equal(source, body.RootElement.GetProperty("source").GetString());
    }

    [Fact]
    public void SourceNamespacesDoNotCollideAndLegacyTelegramIdIsUnchanged()
    {
        var alert = Alert(new Clock());
        var ids = new[] { "TELEGRAM", "LARK_A_CHROME", "LARK_B_BRAVE" }
            .Select(s => RequestSigning.EventId(alert with { Source = s }, "home-windows")).ToArray();
        Assert.Equal(3, ids.Distinct().Count());
        var parts = new[] { "home-windows", alert.SourceAppId, "42", RequestSigning.Utc(alert.CreatedAtUtc) };
        var legacy = string.Concat(parts.Select(s => Encoding.UTF8.GetByteCount(s) + ":" + s));
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(legacy))), ids[0]);
    }

    [Theory]
    [InlineData("TELEGRAM")][InlineData("LARK_A_CHROME")][InlineData("LARK_B_BRAVE")]
    public async Task StandbyNeverQueuesAndOldMonitoringGenerationNeverReplays(string source)
    {
        var clock = new Clock();
        var current = Status(clock, AgentMode.Standby) with { EnabledSources = [source] };
        using var handler = new Handler((_, _, _) => Task.FromResult(Response(HttpStatusCode.OK, "ok")));
        using var client = new HttpClient(handler);
        await using var service = new CloudAgentService(new(client, clock, new Delay(clock)), new Local(), () => current, clock, "test");
        service.Configure(Options());
        var alert = Alert(clock) with { Source = source };
        await service.DispatchAsync(alert, CancellationToken.None); // must not be queued in standby
        current = current with { Mode = AgentMode.Monitoring, MonitoringGeneration = 1 };
        await service.DispatchAsync(alert, CancellationToken.None); // queued, then rearm before pump starts
        current = current with { MonitoringGeneration = 3 };
        var dropped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        service.Changed += () => { if (service.GetStatus().Message.Contains("DROPPED")) dropped.TrySetResult(); };
        service.Start();
        await dropped.Task.WaitAsync(TimeSpan.FromSeconds(3));
        Assert.DoesNotContain(handler.Requests, r => r.Path == "/api/alert");
    }

    [Fact]
    public async Task DisabledSourceAndUnknownSourceCannotEnterCloudQueue()
    {
        var clock = new Clock();
        using var handler = new Handler((_, request, _) => Task.FromResult(Response(HttpStatusCode.OK, request.RequestUri!.AbsolutePath == "/api/alert" ? "ACCEPTED" : "ok")));
        using var client = new HttpClient(handler);
        var current = Status(clock) with { EnabledSources = ["LARK_B_BRAVE"] };
        await using var service = new CloudAgentService(new(client, clock, new Delay(clock)), new Local(), () => current, clock, "test");
        service.Configure(Options());
        foreach (var source in new[] { "TELEGRAM", "LARK_A_CHROME", "UNKNOWN" })
            await service.DispatchAsync(Alert(clock) with { Source = source }, CancellationToken.None);
        // A valid marker drains the queue; only that source may reach HTTP.
        await service.DispatchAsync(Alert(clock) with { Source = "LARK_B_BRAVE" }, CancellationToken.None);
        var drained = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        service.Changed += () => { if (service.GetStatus().LastAlertUtc is not null) drained.TrySetResult(); };
        service.Start();
        await drained.Task.WaitAsync(TimeSpan.FromSeconds(3));
        using var body = JsonDocument.Parse(Assert.Single(handler.Requests, r => r.Path == "/api/alert").Body);
        Assert.Equal("LARK_B_BRAVE", body.RootElement.GetProperty("source").GetString());
    }

    [Theory]
    [InlineData("TELEGRAM")][InlineData("LARK_A_CHROME")][InlineData("LARK_B_BRAVE")]
    public async Task StandbyBetweenAttemptsStopsCloudRetriesForEverySource(string source)
    {
        var clock = new Clock();
        var current = Status(clock) with { EnabledSources = [source] };
        using var handler = new Handler((_, request, _) =>
        {
            if (request.RequestUri!.AbsolutePath == "/api/alert")
            {
                current = current with { Mode = AgentMode.Standby, MonitoringGeneration = 1 };
                return Task.FromResult(Response(HttpStatusCode.ServiceUnavailable, "error"));
            }
            return Task.FromResult(Response(HttpStatusCode.OK, "ok"));
        });
        using var client = new HttpClient(handler);
        await using var service = new CloudAgentService(new(client, clock, new Delay(clock)), new Local(), () => current, clock, "test");
        service.Configure(Options());
        await service.DispatchAsync(Alert(clock) with { Source = source }, CancellationToken.None);
        var dropped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        service.Changed += () => { if (service.GetStatus().Message.Contains("DROPPED")) dropped.TrySetResult(); };
        service.Start();
        await dropped.Task.WaitAsync(TimeSpan.FromSeconds(3));
        Assert.Single(handler.Requests, r => r.Path == "/api/alert");
        Assert.Null(service.GetStatus().LastAlertUtc);
    }

    [Fact]
    public async Task BrowserOnlyHeartbeatDoesNotClaimTelegramConfirmation()
    {
        var clock = new Clock();
        using var handler = new Handler((_, _, _) => Task.FromResult(Response(HttpStatusCode.OK, "ok")));
        using var client = new HttpClient(handler);
        await new CloudTransport(client, clock, new Delay(clock)).HeartbeatAsync(Options(),
            Status(clock) with { TelegramSourceConfirmed = false, EnabledSources = ["LARK_A_CHROME"] }, "session", "1.0.1", false, CancellationToken.None);
        using var body = JsonDocument.Parse(Assert.Single(handler.Requests).Body);
        Assert.False(body.RootElement.GetProperty("telegramSourceConfirmed").GetBoolean());
        Assert.Equal("LARK_A_CHROME", body.RootElement.GetProperty("enabledSources")[0].GetString());
    }

    private sealed class Clock : IClock { public DateTimeOffset UtcNow { get; set; } = DateTimeOffset.Parse("2026-11-02T03:00:00Z"); }
    private sealed class Delay(Clock clock, int? advanceSeconds = null) : IAsyncDelay
    {
        public List<TimeSpan> Waits { get; } = [];
        public Task DelayAsync(TimeSpan delay, CancellationToken token) { token.ThrowIfCancellationRequested(); Waits.Add(delay); clock.UtcNow += TimeSpan.FromSeconds(advanceSeconds ?? delay.TotalSeconds); return Task.CompletedTask; }
    }
    private sealed class Local : IAlertDispatcher
    {
        public int Count { get; private set; }
        public Task DispatchAsync(WorkAlertEvent alert, CancellationToken cancellationToken) { Count++; return Task.CompletedTask; }
    }
    private sealed record Recorded(string Path, byte[] Body, Dictionary<string, string> Headers);
    private sealed class Handler(Func<int, HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        private int _count;
        public ConcurrentQueue<Recorded> Requests { get; } = new();
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Enqueue(new(request.RequestUri!.AbsolutePath, request.Content is null ? [] : await request.Content.ReadAsByteArrayAsync(cancellationToken), request.Headers.ToDictionary(pair => pair.Key, pair => pair.Value.Single())));
            return await send(Interlocked.Increment(ref _count), request, cancellationToken);
        }
    }
    private static HttpResponseMessage Response(HttpStatusCode status, string result) => new(status) { Content = new StringContent(JsonSerializer.Serialize(new { status = result })) };
}
