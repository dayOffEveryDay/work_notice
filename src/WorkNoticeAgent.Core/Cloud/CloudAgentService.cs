using System.Threading.Channels;

namespace WorkNoticeAgent.Core.Cloud;

public sealed class CloudAgentService : IAlertDispatcher, IAsyncDisposable
{
    private sealed record Pending(WorkAlertEvent Alert, CloudOptions Options, long Generation, long MonitoringGeneration);
    private readonly Channel<Pending> _queue;
    private readonly CloudTransport _transport;
    private readonly IAlertDispatcher _local;
    private readonly Func<AgentStatus> _status;
    private readonly IClock _clock;
    private readonly TimeSpan _interval;
    private readonly CancellationTokenSource _stop = new();
    private CancellationTokenSource _activity = new();
    private readonly SemaphoreSlim _heartbeatGate = new(1);
    private readonly object _sync = new();
    private readonly string _session = Guid.NewGuid().ToString("N");
    private readonly string _version;
    private CloudOptions? _options;
    private long _generation;
    private bool _started;
    private volatile bool _paused;
    private volatile bool _stopping;
    private CloudStatus _cloud = new("尚未設定雲端");
    private Task? _pump;
    private Task? _heartbeat;
    public event Action? Changed;
    public CloudStatus GetStatus() { lock (_sync) return _cloud; }
    public CloudAgentService(CloudTransport transport, IAlertDispatcher local, Func<AgentStatus> status,
        IClock clock, string version, TimeSpan? heartbeatInterval = null, int capacity = 100)
    {
        (_transport, _local, _status, _clock, _version) = (transport, local, status, clock, version);
        _interval = heartbeatInterval ?? TimeSpan.FromSeconds(60);
        _queue = Channel.CreateBounded<Pending>(new BoundedChannelOptions(capacity) { FullMode = BoundedChannelFullMode.Wait, SingleReader = true });
    }
    public void Configure(CloudOptions options)
    {
        if (_stopping) return;
        CancellationTokenSource previous;
        lock (_sync)
        {
            previous = _activity;
            _activity = new();
            _options = options;
            _generation++;
            _cloud = new("雲端設定已載入，等待心跳確認", true);
        }
        previous.Cancel();
        Changed?.Invoke();
        if (_started) _ = HeartbeatOnceAsync();
    }
    public void Start()
    {
        if (_started) return;
        _started = true;
        _pump = Task.Run(PumpAsync);
        _heartbeat = Task.Run(HeartbeatLoopAsync);
    }
    public void Pause()
    {
        CancellationTokenSource activity;
        lock (_sync) { _paused = true; _generation++; activity = _activity; }
        activity.Cancel(); // Stop in-flight retries; resume is allowed only after the notification baseline.
    }
    public async Task ResumeAsync()
    {
        if (_stopping) return;
        lock (_sync) { _activity = new(); _paused = false; }
        await HeartbeatOnceAsync();
    }
    public async Task DispatchAsync(WorkAlertEvent alert, CancellationToken cancellationToken)
    {
        await _local.DispatchAsync(alert, cancellationToken);
        if (alert.Source is not ("TELEGRAM" or "LARK_A_CHROME" or "LARK_B_BRAVE")) return;
        var current = _status();
        if (current.Mode != AgentMode.Monitoring || current.Health != ListenerHealth.Ready ||
            current.Access != NotificationAccess.Allowed ||
            current.EnabledSources is { } sources && !sources.Contains(alert.Source)) return;
        CloudOptions? options;
        long generation;
        lock (_sync) { options = _options; generation = _generation; }
        if (options is null || _stopping || _paused) return;
        if (!_queue.Writer.TryWrite(new(alert, options, generation, current.MonitoringGeneration))) Update("雲端佇列已滿，事件未送出", generation: generation);
    }
    private bool CanSend(Pending pending)
    {
        var current = _status();
        lock (_sync) return !_paused && !_stopping && pending.Generation == _generation &&
            current.Mode == AgentMode.Monitoring && current.Health == ListenerHealth.Ready &&
            current.Access == NotificationAccess.Allowed && current.MonitoringGeneration == pending.MonitoringGeneration &&
            (current.EnabledSources is null || current.EnabledSources.Contains(pending.Alert.Source)) &&
            pending.Alert.CreatedAtUtc <= _clock.UtcNow.AddSeconds(30) &&
            _clock.UtcNow - pending.Alert.CreatedAtUtc <= TimeSpan.FromSeconds(120);
    }
    private async Task PumpAsync()
    {
        try
        {
            await foreach (var pending in _queue.Reader.ReadAllAsync(_stop.Token))
            {
                CancellationToken activity;
                lock (_sync) activity = _activity.Token;
                using var attempt = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token, activity);
                try
                {
                    var result = await _transport.AlertAsync(pending.Options, pending.Alert, () => CanSend(pending), attempt.Token);
                    Update(result.Success ? "工作事件已送達雲端：" + result.Code : result.Code == "STALE" ? "工作事件已過期，雲端不觸發警報" : "工作事件未送達：" + result.Code, alert: result.Success, generation: pending.Generation);
                }
                catch (OperationCanceledException) when (!_stop.IsCancellationRequested) { }
            }
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
        catch { Update("雲端傳送異常，請重新啟動程式"); }
    }
    private async Task HeartbeatLoopAsync()
    {
        try
        {
            await HeartbeatOnceAsync();
            using var timer = new PeriodicTimer(_interval);
            while (await timer.WaitForNextTickAsync(_stop.Token)) await HeartbeatOnceAsync();
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
    }
    public async Task HeartbeatOnceAsync()
    {
        try
        {
            await _heartbeatGate.WaitAsync(_stop.Token);
            try
            {
                CloudOptions? options;
                long generation;
                CancellationToken activity;
                lock (_sync) { options = _options; generation = _generation; activity = _activity.Token; }
                if (options is null || _paused || _stopping) return;
                using var attempt = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token, activity);
                var result = await _transport.HeartbeatAsync(options, _status(), _session, _version, false, attempt.Token,
                    () => !_paused && !_stopping && Interlocked.Read(ref _generation) == generation);
                Update(result.Success ? "雲端心跳已確認" : "心跳失敗：" + result.Code, heartbeat: result.Success, generation: generation);
            }
            finally { _heartbeatGate.Release(); }
        }
        catch (OperationCanceledException) { }
        catch { Update("心跳異常"); }
    }
    public async Task<CloudResult> TestAsync(CancellationToken token)
    {
        CloudOptions? options;
        long generation;
        lock (_sync) { options = _options; generation = _generation; }
        if (options is null) return new(false, "NOT_CONFIGURED");
        var health = await _transport.TestAsync(options, token);
        Update(health.Success ? "Worker 健康檢查成功，仍需心跳驗證金鑰" : "連線測試失敗：" + health.Code, generation: generation);
        if (health.Success) await HeartbeatOnceAsync();
        return health;
    }
    public async Task StopAsync()
    {
        if (_stopping) return;
        _stopping = true;
        _stop.Cancel();
        _queue.Writer.TryComplete();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        try
        {
            await _heartbeatGate.WaitAsync(deadline.Token);
            try
            {
                CloudOptions? options;
                lock (_sync) options = _options;
                if (options is null) return;
                var result = await _transport.HeartbeatAsync(options, _status(), _session, _version, true, deadline.Token);
                Update(result.Success ? "已回報正常退出" : "退出回報未確認：" + result.Code);
            }
            finally { _heartbeatGate.Release(); }
        }
        catch { Update("退出回報未確認；雲端之後可能判定離線"); }
    }
    private void Update(string message, bool heartbeat = false, bool alert = false, long? generation = null)
    {
        lock (_sync)
        {
            if (generation.HasValue && generation.Value != _generation) return;
            _cloud = _cloud with { Message = message,
                LastHeartbeatUtc = heartbeat ? _clock.UtcNow : _cloud.LastHeartbeatUtc,
                LastAlertUtc = alert ? _clock.UtcNow : _cloud.LastAlertUtc };
        }
        Changed?.Invoke();
    }
    public async ValueTask DisposeAsync()
    {
        _stopping = true;
        _stop.Cancel();
        _queue.Writer.TryComplete();
        try { await Task.WhenAll(_pump ?? Task.CompletedTask, _heartbeat ?? Task.CompletedTask).WaitAsync(TimeSpan.FromMilliseconds(250)); }
        catch (OperationCanceledException) { }
        catch (TimeoutException) { }
    }
}
