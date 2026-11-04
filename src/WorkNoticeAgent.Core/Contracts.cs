namespace WorkNoticeAgent.Core;

public enum AgentMode { Standby, Monitoring }
public enum NotificationAccess { Unspecified, Allowed, Denied }
public enum ListenerHealth { Ready, AccessRequired, AccessDenied, Error }
public sealed record NotificationMetadata(string SourceAppId, string DisplayName, uint Id, DateTimeOffset CreatedAtUtc)
{
    public string DeduplicationKey => $"{SourceAppId.Length}:{SourceAppId}:{Id}:{CreatedAtUtc.UtcTicks}";
}
public sealed record WorkAlertEvent(Guid EventId, string Source, string SourceAppId,
    uint WindowsNotificationId, DateTimeOffset CreatedAtUtc, DateTimeOffset DetectedAtUtc, string DeduplicationKey);
public sealed record AgentStatus(AgentMode Mode, NotificationAccess Access, ListenerHealth Health,
    DateTimeOffset? LastProcessedAtUtc, string? Error, DateTimeOffset TimestampUtc, DateTimeOffset? LastNotificationAtUtc = null, bool TelegramSourceConfirmed = false, long MonitoringGeneration = 0, IReadOnlyList<string>? EnabledSources = null);
public sealed record DiagnosticEvent(DateTimeOffset Time, NotificationMetadata? Notification, string Result);
public sealed record BrowserSourceSettings(string? AppId = null, bool Enabled = false);
public sealed record AgentSettings(string? TelegramAppId = null, bool TelegramEnabled = true,
    BrowserSourceSettings? LarkChrome = null, BrowserSourceSettings? LarkBrave = null)
{
    [System.Text.Json.Serialization.JsonExtensionData]
    public Dictionary<string, System.Text.Json.JsonElement>? AdditionalSettings { get; init; }
    public bool HasEnabledSource => TelegramEnabled && !string.IsNullOrWhiteSpace(TelegramAppId)
        || LarkChrome is { Enabled: true, AppId: not null } && !string.IsNullOrWhiteSpace(LarkChrome.AppId)
        || LarkBrave is { Enabled: true, AppId: not null } && !string.IsNullOrWhiteSpace(LarkBrave.AppId);

    public IReadOnlyList<string> EnabledSources => new[] {
        TelegramEnabled && !string.IsNullOrWhiteSpace(TelegramAppId) ? "TELEGRAM" : null,
        LarkChrome is { Enabled: true, AppId: not null } && !string.IsNullOrWhiteSpace(LarkChrome.AppId) ? "LARK_A_CHROME" : null,
        LarkBrave is { Enabled: true, AppId: not null } && !string.IsNullOrWhiteSpace(LarkBrave.AppId) ? "LARK_B_BRAVE" : null
    }.OfType<string>().ToArray();

    public void Validate()
    {
        var ids = new[] { TelegramAppId, LarkChrome?.AppId, LarkBrave?.AppId }.Where(id => !string.IsNullOrWhiteSpace(id)).ToArray();
        if (ids.Distinct(StringComparer.Ordinal).Count() != ids.Length)
            throw new ArgumentException("三個來源不可使用相同 AUMID，以免將通知錯認為其他來源。");
        if (LarkChrome is { Enabled: true } && string.IsNullOrWhiteSpace(LarkChrome.AppId)
            || LarkBrave is { Enabled: true } && string.IsNullOrWhiteSpace(LarkBrave.AppId))
            throw new ArgumentException("啟用瀏覽器來源前，請先選取並信任實際觀察到的通知 AUMID。");
    }
}

public interface INotificationSource : IDisposable
{
    event Action<NotificationMetadata>? Added;
    event Action<string>? Faulted;
    NotificationAccess GetAccess();
    Task<NotificationAccess> RequestAccessAsync();
    void Start();
    void Stop();
    Task<IReadOnlyList<NotificationMetadata>> SnapshotAsync(CancellationToken cancellationToken);
}
public interface IAlertDispatcher { Task DispatchAsync(WorkAlertEvent alert, CancellationToken cancellationToken); }
public interface IAgentStatusProvider { AgentStatus GetStatus(); }
public interface IClock { DateTimeOffset UtcNow { get; } }
public sealed class SystemClock : IClock { public DateTimeOffset UtcNow => DateTimeOffset.UtcNow; }
public interface ITelegramSourceMatcher { bool Matches(NotificationMetadata notification, string? confirmedAppId); }
public sealed class ConfirmedTelegramSourceMatcher : ITelegramSourceMatcher
{
    public bool Matches(NotificationMetadata notification, string? confirmedAppId) =>
        !string.IsNullOrWhiteSpace(confirmedAppId) && string.Equals(notification.SourceAppId, confirmedAppId, StringComparison.Ordinal);
}
public interface INotificationDeduplicator { bool Remember(NotificationMetadata notification); }
public interface ISettingsStore
{
    Task<AgentSettings> LoadAsync(CancellationToken cancellationToken);
    Task SaveAsync(AgentSettings settings, CancellationToken cancellationToken);
}
public interface ISafeLog { void Write(string code, NotificationMetadata? notification = null); }
