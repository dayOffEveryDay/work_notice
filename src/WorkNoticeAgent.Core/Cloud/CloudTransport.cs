using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;

namespace WorkNoticeAgent.Core.Cloud;

public sealed class CloudTransport(HttpClient client, IClock clock, IAsyncDelay delay, Func<int>? jitter = null)
{
    private static readonly int[] RetrySeconds = [2, 5, 15];
    public byte[] AlertBody(CloudOptions options, WorkAlertEvent alert) => JsonSerializer.SerializeToUtf8Bytes(new
    {
        eventId = RequestSigning.EventId(alert, options.DeviceId), deviceId = options.DeviceId,
        source = alert.Source, aumid = alert.SourceAppId, notificationId = alert.WindowsNotificationId,
        occurredAt = RequestSigning.Utc(alert.CreatedAtUtc)
    });
    public Task<CloudResult> AlertAsync(CloudOptions options, WorkAlertEvent alert, Func<bool> canSend, CancellationToken token) =>
        SendAsync(options, "/api/alert", AlertBody(options, alert), canSend, token, true);
    public Task<CloudResult> HeartbeatAsync(CloudOptions options, AgentStatus status, string sessionId, string version,
        bool stopped, CancellationToken token, Func<bool>? canSend = null) => SendAsync(options, "/api/heartbeat", JsonSerializer.SerializeToUtf8Bytes(new
        {
            deviceId = options.DeviceId, sessionId, agentMode = stopped ? "STOPPED_BY_USER" : status.Mode == AgentMode.Monitoring ? "MONITORING" : "STANDBY",
            listenerStatus = status.Health == ListenerHealth.Ready ? "READY" : status.Health == ListenerHealth.Error ? "ERROR" : "DEGRADED",
            notificationPermission = status.Access.ToString().ToUpperInvariant(), telegramSourceConfirmed = status.TelegramSourceConfirmed, agentVersion = version, enabledSources = status.EnabledSources
        }), canSend ?? (() => true), token, !stopped);

    private async Task<CloudResult> SendAsync(CloudOptions options, string path, byte[] body, Func<bool> canSend, CancellationToken token, bool retry)
    {
        if (body.Length > 8192) return new(false, "BODY_TOO_LARGE");
        for (var attempt = 0; ; attempt++)
        {
            token.ThrowIfCancellationRequested();
            if (!canSend()) return new(false, "DROPPED");
            var timestamp = clock.UtcNow.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture);
            var nonce = Guid.NewGuid().ToString("N");
            using var request = new HttpRequestMessage(HttpMethod.Post, options.Endpoint + path);
            request.Content = new ByteArrayContent(body);
            request.Content.Headers.ContentType = new("application/json");
            request.Headers.Add("X-Device-Id", options.DeviceId);
            request.Headers.Add("X-Timestamp", timestamp);
            request.Headers.Add("X-Nonce", nonce);
            request.Headers.Add("X-Signature", RequestSigning.Sign("POST", path, options.DeviceId, timestamp, nonce, body, options.Secret));
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            var code = "NETWORK_ERROR";
            var transient = false;
            try
            {
                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).WaitAsync(timeout.Token).ConfigureAwait(false);
                if (response.IsSuccessStatusCode)
                {
                    await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false);
                    var buffer = new byte[4097];
                    var size = 0;
                    while (size < buffer.Length)
                    {
                        var read = await stream.ReadAsync(buffer.AsMemory(size), timeout.Token).ConfigureAwait(false);
                        if (read == 0) break;
                        size += read;
                    }
                    if (size > 4096) return new(false, "INVALID_RESPONSE");
                    using var document = JsonDocument.Parse(buffer.AsMemory(0, size));
                    var result = document.RootElement.GetProperty("status").GetString();
                    if (path == "/api/heartbeat" && result == "ok") return new(true, "OK");
                    if (path == "/api/alert" && result is "ACCEPTED" or "DUPLICATE") return new(true, result);
                    if (result == "STALE") return new(false, "STALE");
                    return new(false, "INVALID_RESPONSE");
                }
                code = "HTTP_" + ((int)response.StatusCode).ToString(CultureInfo.InvariantCulture);
                transient = response.StatusCode is HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests || (int)response.StatusCode >= 500;
            }
            catch (OperationCanceledException) when (!token.IsCancellationRequested) { code = "TIMEOUT"; transient = true; }
            catch (HttpRequestException) { transient = true; }
            catch (IOException) { transient = true; }
            catch (JsonException) { return new(false, "INVALID_RESPONSE"); }
            catch (KeyNotFoundException) { return new(false, "INVALID_RESPONSE"); }
            catch (InvalidOperationException) { return new(false, "INVALID_RESPONSE"); }
            if (!retry || !transient || attempt == RetrySeconds.Length) return new(false, code);
            await delay.DelayAsync(TimeSpan.FromSeconds(RetrySeconds[attempt]) + TimeSpan.FromMilliseconds(jitter?.Invoke() ?? Random.Shared.Next(251)), token).ConfigureAwait(false);
        }
    }
    public async Task<CloudResult> TestAsync(CloudOptions options, CancellationToken token)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            using var request = new HttpRequestMessage(HttpMethod.Get, options.Endpoint + "/api/health");
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).WaitAsync(timeout.Token).ConfigureAwait(false);
            return new(response.IsSuccessStatusCode, response.IsSuccessStatusCode ? "HEALTH_OK" : "HTTP_" + (int)response.StatusCode);
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested) { return new(false, "TIMEOUT"); }
        catch (HttpRequestException) { return new(false, "NETWORK_ERROR"); }
    }
}
