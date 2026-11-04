namespace WorkNoticeAgent.Core.Cloud;

public sealed class CloudOptions
{
    public string Endpoint { get; }
    public string DeviceId { get; }
    public string Secret { get; }
    public CloudOptions(string endpoint, string deviceId, string secret)
    {
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) || uri.Scheme != "https" ||
            uri.AbsolutePath != "/" || uri.Query.Length != 0 || uri.Fragment.Length != 0 || uri.UserInfo.Length != 0)
            throw new ArgumentException("Worker endpoint must be an HTTPS origin.");
        if (!System.Text.RegularExpressions.Regex.IsMatch(deviceId, "^[a-z0-9][a-z0-9_-]{0,63}$"))
            throw new ArgumentException("Invalid device ID.");
        if (secret.Length < 32 || secret.Length > 512 || secret.Any(char.IsControl)) throw new ArgumentException("Invalid secret length or characters.");
        Endpoint = uri.GetLeftPart(UriPartial.Authority);
        DeviceId = deviceId;
        Secret = secret;
    }
    public override string ToString() => "Cloud settings (secret protected)";
}
public interface ICloudSettingsStore
{
    Task<CloudOptions?> LoadAsync(CancellationToken cancellationToken);
    Task SaveAsync(CloudOptions options, CancellationToken cancellationToken);
}
public sealed record CloudStatus(string Message, bool Configured = false,
    DateTimeOffset? LastHeartbeatUtc = null, DateTimeOffset? LastAlertUtc = null);
public interface IAsyncDelay { Task DelayAsync(TimeSpan delay, CancellationToken token); }
public sealed class AsyncDelay : IAsyncDelay
{
    public Task DelayAsync(TimeSpan delay, CancellationToken token) => Task.Delay(delay, token);
}
public sealed record CloudResult(bool Success, string Code);
