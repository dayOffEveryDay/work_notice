using System;
using System.IO;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using Microsoft.Win32;
using WorkNoticeAgent.Core;
using WorkNoticeAgent.Windows;
using WorkNoticeAgent.Core.Cloud;

namespace WorkNoticeAgent.App;

public partial class App : Application
{
    private Mutex? _instance;
    private bool _ownsMutex;
    private AgentController? _agent;
    private TrayService? _tray;
    private CloudAgentService? _cloud;
    private HttpClient? _http;
    private readonly CancellationTokenSource _stop = new();
    private Task? _healthLoop;
    private bool _exiting;
    private bool _suspended;
    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        _instance = new Mutex(true, "Local\\WorkNoticeAgent.SingleInstance", out _ownsMutex);
        if (!_ownsMutex) { MessageBox.Show("Work Notice Agent 已在執行。請從系統匣開啟主畫面。"); Shutdown(); return; }
        try
        {
            if (!WindowsNotificationSource.HasPackageIdentity())
            {
                MessageBox.Show("缺少 Package Identity。請安裝 MSIX，從開始選單啟動；不可直接執行 bin 內的 exe 來驗證通知功能。", "Work Notice Agent");
                Shutdown();
                return;
            }
            var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WorkNoticeAgent");
            var log = new RollingSafeLog(Path.Combine(directory, "Logs"));
            var source = new WindowsNotificationSource();
            var clock = new SystemClock();
            _http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = Timeout.InfiniteTimeSpan };
            _cloud = new(new CloudTransport(_http, clock, new AsyncDelay()), new LocalDebugAlertDispatcher(log),
                () => _agent!.GetStatus(), clock, typeof(App).Assembly.GetName().Version?.ToString() ?? "1.0.0");
            _agent = new(source, _cloud, new BoundedNotificationDeduplicator(), new ConfirmedTelegramSourceMatcher(), clock, log);
            var model = new MainViewModel(_agent, source, new JsonSettingsStore(directory), Dispatcher, _cloud, new ProtectedCloudSettingsStore(directory));
            var window = new MainWindow { DataContext = model };
            MainWindow = window;
            _tray = new(window, model, _agent, () => _ = ExitAsync(), Dispatcher);
            window.Show();
            await model.InitializeAsync();
            if (_exiting) return;
            _cloud.Start();
            SystemEvents.PowerModeChanged += OnPowerModeChanged;
            _healthLoop = WatchAccessAsync();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"啟動失敗：0x{ex.HResult:X8}。請檢查封裝與通知 API 支援。", "Work Notice Agent");
            await ExitAsync();
        }
    }
    private async Task WatchAccessAsync()
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        try
        {
            while (await timer.WaitForNextTickAsync(_stop.Token))
                if (!_suspended && _agent is not null) await _agent.CheckAccessAsync();
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
    }
    private void OnPowerModeChanged(object sender, PowerModeChangedEventArgs e)
    {
        // Immediately blocks processing, before the queued resume baseline can run.
        if (e.Mode == PowerModes.Suspend) { _agent?.Suspend(); _cloud?.Pause(); }
        Dispatcher.BeginInvoke(async () =>
        {
            if (_exiting || _agent is null) return;
            if (e.Mode == PowerModes.Suspend) _suspended = true;
            if (e.Mode == PowerModes.Resume)
            {
                await _agent.RefreshAsync();
                if (_cloud is not null) await _cloud.ResumeAsync();
                _suspended = false;
            }
        });
    }
    private async Task ExitAsync()
    {
        if (_exiting) return;
        _exiting = true;
        if (MainWindow is not null) MainWindow.IsEnabled = false;
        SystemEvents.PowerModeChanged -= OnPowerModeChanged;
        _stop.Cancel();
        if (_healthLoop is not null) await _healthLoop;
        _agent?.Suspend();
        if (_cloud is not null) await _cloud.StopAsync();
        if (_agent is not null) await _agent.DisposeAsync();
        if (_cloud is not null) await _cloud.DisposeAsync();
        _tray?.Dispose();
        if (MainWindow is MainWindow window) { window.Exiting = true; window.Close(); }
        Shutdown();
    }
    protected override void OnSessionEnding(SessionEndingCancelEventArgs e)
    {
        _stop.Cancel();
        _agent?.Suspend();
        _cloud?.Pause();
        _tray?.Dispose();
        base.OnSessionEnding(e);
    }
    protected override void OnExit(ExitEventArgs e)
    {
        if (_ownsMutex) _instance?.ReleaseMutex();
        _instance?.Dispose();
        _stop.Dispose();
        _http?.Dispose();
        base.OnExit(e);
    }
}
