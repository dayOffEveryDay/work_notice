using System;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Threading;
using WorkNoticeAgent.Core;
using WorkNoticeAgent.App.Presentation;
using WorkNoticeAgent.Core.Cloud;

namespace WorkNoticeAgent.App;

public sealed record SourceChoice(string Id, string Name)
{
    public override string ToString() => $"{Name}  [{Id}]";
}
public sealed class MainViewModel : INotifyPropertyChanged
{
    private readonly AgentController _agent;
    private readonly INotificationSource _source;
    private readonly ISettingsStore _settings;
    private readonly Dispatcher _ui;
    private readonly CloudAgentService _cloud;
    private readonly ICloudSettingsStore _cloudStore;
    private CloudOptions? _savedCloud;
    private string _endpoint = "https://work-notice-api.hui760419.workers.dev";
    private string _deviceId = "home-windows";
    private string? _cloudError;
    private SourceChoice? _selected;
    private string? _confirmedId;
    private AgentSettings _savedSources = new();
    private bool _sourcesLoaded;
    private SourceChoice? _chromeSource, _braveSource;
    private bool _telegramEnabled = true, _chromeEnabled, _braveEnabled;
    private readonly System.Collections.Generic.HashSet<string> _observed = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _sourceEdits = new(1);
    private string _message = "請先授權，再讓 Telegram 產生 Windows 系統通知；重新掃描並確認來源。";
    public event PropertyChangedEventHandler? PropertyChanged;
    public ObservableCollection<SourceChoice> Sources { get; } = [];
    public ObservableCollection<DiagnosticEvent> Events { get; } = [];
    public AsyncCommand RequestAccess { get; }
    public AsyncCommand Refresh { get; }
    public AsyncCommand Monitor { get; }
    public AsyncCommand Standby { get; }
    public AsyncCommand ConfirmSource { get; }
    public AsyncCommand TestCloud { get; }
    public AsyncCommand SaveSources { get; }
    public SourceChoice? ChromeSource { get => _chromeSource; set { _chromeSource = value; Notify(); } }
    public SourceChoice? BraveSource { get => _braveSource; set { _braveSource = value; Notify(); } }
    public bool TelegramEnabled { get => _telegramEnabled; set { _telegramEnabled = value; Notify(); } }
    public bool ChromeEnabled { get => _chromeEnabled; set { _chromeEnabled = value; Notify(); } }
    public bool BraveEnabled { get => _braveEnabled; set { _braveEnabled = value; Notify(); } }
    public string TelegramStatus => SourceStatus(_savedSources.TelegramAppId, _savedSources.TelegramEnabled, false);
    public string ChromeStatus => SourceStatus(_savedSources.LarkChrome?.AppId, _savedSources.LarkChrome?.Enabled == true, true);
    public string BraveStatus => SourceStatus(_savedSources.LarkBrave?.AppId, _savedSources.LarkBrave?.Enabled == true, true);
    private string SourceStatus(string? id, bool enabled, bool browser) => !_sourcesLoaded ? "來源設定尚未載入或讀取失敗；請查看錯誤提示"
        : string.IsNullOrWhiteSpace(id)
        ? "尚未確認來源（不會辨識未知通知）"
        : $"{(enabled ? "已啟用" : "已停用")} · {(_observed.Contains(id) ? "本次已觀察到" : "已保存，等待實際通知驗證")}{(browser ? " · 雲端來源需通過 Worker 白名單" : "")}";
    public string WorkerEndpoint { get => _endpoint; set { _endpoint = value; Notify(); } }
    public string CloudDeviceId { get => _deviceId; set { _deviceId = value; Notify(); } }
    public string CloudMessage => _cloudError ?? _cloud.GetStatus().Message;
    public string LastHeartbeat => _cloud.GetStatus().LastHeartbeatUtc is { } time ? TaiwanTimeDisplay.Format(time) : "尚無成功心跳";
    public string LastCloudAlert => _cloud.GetStatus().LastAlertUtc is { } time ? TaiwanTimeDisplay.Format(time) : "尚無成功事件傳送";
    public SourceChoice? SelectedSource { get => _selected; set { _selected = value; Notify(); ConfirmSource.Raise(); } }
    public string ConfirmedSource => _confirmedId ?? "尚未確認 Telegram 來源";
    public string Mode => _agent.GetStatus().Mode == AgentMode.Monitoring ? "監控中" : "待命中";
    public string Access => _agent.GetStatus().Access switch { NotificationAccess.Allowed => "已允許", NotificationAccess.Denied => "已拒絕／撤銷", _ => "尚未授權" };
    public string Health => _agent.GetStatus().Health switch { ListenerHealth.Ready => "就緒", ListenerHealth.AccessDenied => "存取被拒絕", ListenerHealth.AccessRequired => "需要授權", _ => "監聽器異常" };
    public string LastEvent => _agent.GetStatus().LastProcessedAtUtc is { } instant ? TaiwanTimeDisplay.Format(instant) : "尚無工作事件";
    public string Message => _agent.GetStatus().Error is { } error ? $"{error}\n{_message}" : _message;
    public MainViewModel(AgentController agent, INotificationSource source, ISettingsStore settings, Dispatcher ui, CloudAgentService cloud, ICloudSettingsStore cloudStore)
    {
        (_agent, _source, _settings, _ui) = (agent, source, settings, ui);
        (_cloud, _cloudStore) = (cloud, cloudStore);
        _cloud.Changed += () => Post(Update);
        TestCloud = new(async () => { _cloudError = null; await _cloud.TestAsync(CancellationToken.None); Update(); }, FailCloud);
        RequestAccess = new(async () => { await _source.RequestAccessAsync(); await _agent.RefreshAsync(); }, Fail);
        Refresh = new(() => _agent.RefreshAsync(), Fail);
        Monitor = new(() => _agent.SetModeAsync(AgentMode.Monitoring), Fail,
            () => _sourcesLoaded && _savedSources.HasEnabledSource && _agent.GetStatus().Health == ListenerHealth.Ready);
        Standby = new(() => _agent.SetModeAsync(AgentMode.Standby), Fail);
        ConfirmSource = new(async () =>
        {
            var selected = SelectedSource!;
            await _sourceEdits.WaitAsync();
            try
            {
                var previousId = _confirmedId;
                var sameSource = string.Equals(previousId, selected.Id, StringComparison.Ordinal);
                var settings = _savedSources with { TelegramAppId = selected.Id };
                settings.Validate();
                if (!sameSource) await _settings.SaveAsync(settings, CancellationToken.None);
                await _agent.ConfirmSourceAsync(selected.Id);
                _savedSources = settings;
                _confirmedId = selected.Id;
                _message = sameSource
                    ? "Telegram AUMID 與已確認來源相同，維持目前模式，不重新建立基線。"
                    : previousId is null
                        ? "首次 Telegram 來源已保存，維持待命。請手動切換到監控中，再發送一則新通知驗證。"
                        : "Telegram AUMID 已變更；為避免誤報已切回待命並重新建立通知基線。請確認監聽器就緒後手動開始監控。";
                Update();
            }
            finally { _sourceEdits.Release(); }
        }, Fail, () => _sourcesLoaded && SelectedSource is not null);
        SaveSources = new(async () =>
        {
            await _sourceEdits.WaitAsync();
            try
            {
                var settings = _savedSources with
                {
                    TelegramEnabled = TelegramEnabled,
                    LarkChrome = _savedSources.LarkChrome is null && ChromeSource is null && !ChromeEnabled ? null : new(ChromeSource?.Id ?? _savedSources.LarkChrome?.AppId, ChromeEnabled),
                    LarkBrave = _savedSources.LarkBrave is null && BraveSource is null && !BraveEnabled ? null : new(BraveSource?.Id ?? _savedSources.LarkBrave?.AppId, BraveEnabled)
                };
                settings.Validate();
                var changed = settings != _savedSources;
                if (changed) await _settings.SaveAsync(settings, CancellationToken.None);
                await _agent.ConfigureSourcesAsync(settings);
                _savedSources = settings;
                _message = changed ? "來源設定已保存；為避免舊通知補發，已重建基線並切回待命，請手動開始監控。" : "設定未變更，維持目前監控狀態。";
                Update();
            }
            finally { _sourceEdits.Release(); }
        }, Fail, () => _sourcesLoaded);
        _agent.Changed += () => Post(Update);
        _agent.SourceObserved += notification => Post(() => { _observed.Add(notification.SourceAppId); AddSource(notification.SourceAppId, notification.DisplayName); Update(); });
        _agent.Diagnostic += diagnostic => Post(() =>
        {
            Events.Insert(0, diagnostic);
            while (Events.Count > 200) Events.RemoveAt(Events.Count - 1);
        });
    }
    public async Task InitializeAsync()
    {
        var sourcesLoaded = true;
        try
        {
            var loaded = await _settings.LoadAsync(CancellationToken.None);
            loaded.Validate();
            _savedSources = loaded;
            _confirmedId = loaded.TelegramAppId;
            _sourcesLoaded = true;
        }
        catch (Exception ex) { sourcesLoaded = false; _sourcesLoaded = false; Fail(ex); }
        if (_confirmedId is not null) AddSource(_confirmedId, "已保存來源");
        if (_savedSources.LarkChrome?.AppId is { } chrome) { AddSource(chrome, "已保存來源"); ChromeSource = Sources.First(s => s.Id == chrome); }
        if (_savedSources.LarkBrave?.AppId is { } brave) { AddSource(brave, "已保存來源"); BraveSource = Sources.First(s => s.Id == brave); }
        TelegramEnabled = _savedSources.TelegramEnabled;
        ChromeEnabled = _savedSources.LarkChrome?.Enabled == true;
        BraveEnabled = _savedSources.LarkBrave?.Enabled == true;
        await _agent.InitializeSettingsAsync(_savedSources);
        if (sourcesLoaded) _message = "已載入來源設定。未觀察到通知不代表來源驗證失敗；請在診斷頁確認真正的 AUMID。";
        try
        {
            _savedCloud = await _cloudStore.LoadAsync(CancellationToken.None);
            if (_savedCloud is not null)
            {
                WorkerEndpoint = _savedCloud.Endpoint;
                CloudDeviceId = _savedCloud.DeviceId;
                _cloud.Configure(_savedCloud);
            }
        }
        catch (Exception ex) { FailCloud(ex); }
        Update();
    }
    public async Task SaveCloudAsync(string secret)
    {
        try
        {
            var options = new CloudOptions(WorkerEndpoint.Trim(), CloudDeviceId.Trim(), string.IsNullOrEmpty(secret) ? _savedCloud?.Secret ?? "" : secret);
            await _cloudStore.SaveAsync(options, CancellationToken.None);
            _savedCloud = options;
            _cloudError = null;
            _cloud.Configure(options);
            Update();
        }
        catch (Exception ex) { FailCloud(ex); }
    }
    private void FailCloud(Exception ex)
    {
        _cloudError = $"雲端設定／操作失敗（0x{ex.HResult:X8}）。請確認 HTTPS 根網址、deviceId、金鑰長度或重新輸入目前使用者的金鑰。";
        Notify(nameof(CloudMessage));
    }
    private void AddSource(string id, string name)
    {
        var existing = Sources.FirstOrDefault(s => s.Id == id);
        if (existing is null) Sources.Add(new(id, name));
        else if (existing.Name == "已保存來源")
        {
            var index = Sources.IndexOf(existing);
            var updated = new SourceChoice(id, name);
            var telegram = ReferenceEquals(SelectedSource, existing);
            var chrome = ReferenceEquals(ChromeSource, existing);
            var brave = ReferenceEquals(BraveSource, existing);
            Sources[index] = updated;
            if (telegram) SelectedSource = updated;
            if (chrome) ChromeSource = updated;
            if (brave) BraveSource = updated;
        }
    }
    private void Post(Action action) { if (!_ui.HasShutdownStarted) _ui.BeginInvoke(action); }
    private void Update() { Notify(string.Empty); Monitor.Raise(); ConfirmSource.Raise(); SaveSources.Raise(); }
    private void Fail(Exception ex) { _message = ex is ArgumentException ? ex.Message : $"操作失敗：0x{ex.HResult:X8}。設定未確認成功，請檢查 MSIX、通知權限及本機日誌。"; Notify(nameof(Message)); }
    private void Notify([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
}
