namespace WorkNoticeAgent.Core;

public sealed class AgentController : IAgentStatusProvider, IAsyncDisposable
{
    private readonly INotificationSource _source;
    private readonly IAlertDispatcher _dispatcher;
    private readonly INotificationDeduplicator _dedup;
    private readonly ITelegramSourceMatcher _matcher;
    private readonly IClock _clock;
    private readonly ISafeLog _log;
    private readonly SemaphoreSlim _gate = new(1);
    private readonly CancellationTokenSource _stop = new();
    private long _generation;
    private bool _disposed;
    private volatile bool _suspended;
    private DateTimeOffset _armedAt = DateTimeOffset.MaxValue;
    private string? _telegramId;
    private AgentSettings _settings = new();
    private volatile AgentStatus _status;
    public event Action? Changed;
    public event Action<NotificationMetadata>? SourceObserved;
    public event Action<DiagnosticEvent>? Diagnostic;

    public AgentController(INotificationSource source, IAlertDispatcher dispatcher,
        INotificationDeduplicator dedup, ITelegramSourceMatcher matcher, IClock clock, ISafeLog log)
    {
        (_source, _dispatcher, _dedup, _matcher, _clock, _log) = (source, dispatcher, dedup, matcher, clock, log);
        _status = new(AgentMode.Standby, NotificationAccess.Unspecified, ListenerHealth.AccessRequired, null, null, clock.UtcNow);
        _source.Added += OnAdded;
        _source.Faulted += OnFaulted;
    }
    public AgentStatus GetStatus() => _status with { TimestampUtc = _clock.UtcNow, TelegramSourceConfirmed = !string.IsNullOrWhiteSpace(_telegramId), MonitoringGeneration = Interlocked.Read(ref _generation), EnabledSources = _settings.EnabledSources };
    public void Suspend()
    {
        _suspended = true;
        Interlocked.Increment(ref _generation);
    }

    // All entry points serialize with notification processing. Epoch invalidates callbacks queued during a baseline.
    public Task InitializeAsync(string? confirmedId) => ExecuteAsync(async () =>
    {
        _telegramId = confirmedId;
        _settings = _settings with { TelegramAppId = confirmedId };
        await BaselineAsync(AgentMode.Standby);
    });
    public Task InitializeSettingsAsync(AgentSettings settings) => ExecuteAsync(async () =>
    {
        settings.Validate();
        _settings = settings;
        _telegramId = settings.TelegramAppId;
        await BaselineAsync(AgentMode.Standby);
    });
    public Task ConfigureSourcesAsync(AgentSettings settings) => ExecuteAsync(async () =>
    {
        settings.Validate();
        if (_settings == settings) return;
        _settings = settings;
        _telegramId = settings.TelegramAppId;
        await BaselineAsync(AgentMode.Standby);
    });
    public Task SetModeAsync(AgentMode mode) => ExecuteAsync(async () =>
    {
        if (mode == AgentMode.Monitoring && !_settings.HasEnabledSource)
        {
            Update(_status with { Mode = AgentMode.Standby, Error = "請至進階設定確認並啟用至少一個通知來源；未知通知不會視為 Telegram。" });
            return;
        }
        await BaselineAsync(mode);
    });
    public Task RefreshAsync() => ExecuteAsync(() => BaselineAsync(_status.Mode));
    public Task ConfirmSourceAsync(string id) => ExecuteAsync(async () =>
    {
        // Reconfirming the exact AUMID must not rearm, discard queued new events,
        // or change a user's current monitoring/standby choice.
        if (string.Equals(_telegramId, id, StringComparison.Ordinal)) return;
        var settings = _settings with { TelegramAppId = id };
        settings.Validate();
        _settings = settings;
        _telegramId = id;
        await BaselineAsync(AgentMode.Standby);
    });
    public Task CheckAccessAsync() => ExecuteAsync(() =>
    {
        if (_source.GetAccess() != NotificationAccess.Allowed) AccessUnavailable();
        return Task.CompletedTask;
    });
    private async Task BaselineAsync(AgentMode requestedMode)
    {
        Interlocked.Increment(ref _generation);
        _source.Stop();
        // Refresh keeps the requested monitoring mode throughout the baseline.
        // The gate and generation prevent forwarding while synchronization runs;
        // an access/subscription/snapshot failure still explicitly enters standby.
        if (requestedMode == AgentMode.Standby) Update(_status with { Mode = AgentMode.Standby });
        if (_source.GetAccess() != NotificationAccess.Allowed) { AccessUnavailable(); return; }
        // Subscribe BEFORE snapshot; callbacks inside this window carry an old epoch and are suppressed.
        _source.Start();
        var snapshot = await _source.SnapshotAsync(_stop.Token);
        if (_source.GetAccess() != NotificationAccess.Allowed) { AccessUnavailable(); return; }
        foreach (var notification in snapshot)
        {
            _dedup.Remember(notification);
            SourceObserved?.Invoke(notification);
        }
        _armedAt = _clock.UtcNow;
        _suspended = false;
        Interlocked.Increment(ref _generation);
        Update(_status with { Mode = requestedMode, Access = NotificationAccess.Allowed, Health = ListenerHealth.Ready, Error = null });
    }
    private void AccessUnavailable()
    {
        _source.Stop();
        Interlocked.Increment(ref _generation);
        var access = _source.GetAccess();
        Update(_status with { Mode = AgentMode.Standby, Access = access,
            Health = access == NotificationAccess.Denied ? ListenerHealth.AccessDenied : ListenerHealth.AccessRequired,
            Error = access == NotificationAccess.Denied ? "通知存取被拒絕或撤銷，請至 Windows 設定重新允許。" : "請按「申請通知權限」。" });
    }
    private void OnAdded(NotificationMetadata notification) => _ = ProcessAsync(notification);
    public Task ProcessAsync(NotificationMetadata notification)
    {
        var epoch = Interlocked.Read(ref _generation);
        return Task.Run(() => ExecuteAsync(async () =>
        {
            if (_source.GetAccess() != NotificationAccess.Allowed) { AccessUnavailable(); return; }
            Update(_status with { LastNotificationAtUtc = _clock.UtcNow });
            SourceObserved?.Invoke(notification);
            string result;
            if (!_dedup.Remember(notification)) result = "重複忽略";
            else if (_suspended || epoch != Interlocked.Read(ref _generation) || notification.CreatedAtUtc <= _armedAt) result = "基線／舊通知忽略";
            else if (_status.Mode != AgentMode.Monitoring || _status.Health != ListenerHealth.Ready) result = "待命忽略";
            else if (MatchSource(notification) is not { } source) result = "來源忽略";
            else
            {
                await _dispatcher.DispatchAsync(new(Guid.NewGuid(), source, notification.SourceAppId, notification.Id,
                    notification.CreatedAtUtc, _clock.UtcNow, notification.DeduplicationKey), _stop.Token);
                result = "已處理";
                Update(_status with { LastProcessedAtUtc = _clock.UtcNow });
            }
            _log.Write(result, notification);
            Diagnostic?.Invoke(new(_clock.UtcNow, notification, result));
        }));
    }
    private string? MatchSource(NotificationMetadata notification)
    {
        if (_settings.TelegramEnabled && _matcher.Matches(notification, _telegramId)) return "TELEGRAM";
        if (_settings.LarkChrome is { Enabled: true } chrome && string.Equals(chrome.AppId, notification.SourceAppId, StringComparison.Ordinal)) return "LARK_A_CHROME";
        if (_settings.LarkBrave is { Enabled: true } brave && string.Equals(brave.AppId, notification.SourceAppId, StringComparison.Ordinal)) return "LARK_B_BRAVE";
        return null;
    }
    private void OnFaulted(string code) => _ = ExecuteAsync(() =>
    {
        // Adapter errors contain stage and HRESULT only, never an exception message with payload.
        _log.Write(code);
        if (code.StartsWith("Listener", StringComparison.Ordinal))
        {
            if (_source.GetAccess() != NotificationAccess.Allowed) AccessUnavailable();
            else
            {
                _source.Stop();
                Interlocked.Increment(ref _generation);
                Update(_status with { Mode = AgentMode.Standby, Health = ListenerHealth.Error, Error = code });
            }
        }
        Diagnostic?.Invoke(new(_clock.UtcNow, null, code));
        return Task.CompletedTask;
    });
    private async Task ExecuteAsync(Func<Task> action)
    {
        try
        {
            await _gate.WaitAsync(_stop.Token);
            try { if (!_disposed) await action(); }
            finally { _gate.Release(); }
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
        catch (Exception ex)
        {
            // Reacquire to publish failure without racing a successful transition.
            await _gate.WaitAsync();
            try
            {
                try { _source.Stop(); }
                catch (Exception stopError) { _log.Write($"ListenerStop:0x{stopError.HResult:X8}"); }
                Interlocked.Increment(ref _generation);
                var code = $"ListenerFailure:0x{ex.HResult:X8}";
                _log.Write(code);
                Update(_status with { Mode = AgentMode.Standby, Health = ListenerHealth.Error, Error = code });
            }
            finally { _gate.Release(); }
        }
    }
    private void Update(AgentStatus status) { _status = status with { TimestampUtc = _clock.UtcNow }; Changed?.Invoke(); }
    public async ValueTask DisposeAsync()
    {
        _stop.Cancel();
        await _gate.WaitAsync();
        try
        {
            _disposed = true;
            _source.Added -= OnAdded;
            _source.Faulted -= OnFaulted;
            _source.Dispose();
        }
        finally { _gate.Release(); }
    }
}
