using System.Net.Http;
using System.Windows.Threading;
using WorkNoticeAgent.App;
using WorkNoticeAgent.Core;
using WorkNoticeAgent.Core.Cloud;
using Xunit;

namespace WorkNoticeAgent.Windows.Tests;

public sealed class SourceViewModelTests
{
    [Fact]
    public Task FailedSettingsLoadCannotOverwriteExistingSources() => OnUi(async () =>
    {
        await using var f = new Fixture();
        f.Settings.FailLoad = true;
        await f.Model.InitializeAsync();
        Assert.False(f.Model.SaveSources.CanExecute(null));
        Assert.False(f.Model.ConfirmSource.CanExecute(null));
        Assert.False(f.Model.Monitor.CanExecute(null));
        f.Model.SaveSources.Execute(null);
        Assert.Equal(0, f.Settings.Writes);
        Assert.Contains("操作失敗", f.Model.Message);
        Assert.Contains("讀取失敗", f.Model.TelegramStatus);
    });

    [Fact]
    public Task UnchangedLegacySettingsDoNotResetMonitoringOrWrite() => OnUi(async () =>
    {
        await using var f = new Fixture();
        await f.Model.InitializeAsync();
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        await Run(f.Model.SaveSources);
        Assert.Equal(0, f.Settings.Writes);
        Assert.Equal("監控中", f.Model.Mode);
        Assert.Contains("等待實際通知驗證", f.Model.TelegramStatus);
    });

    [Fact]
    public Task SaveFailureNeverShowsBrowserAsEnabledOrChangesTelegram() => OnUi(async () =>
    {
        await using var f = new Fixture();
        await f.Model.InitializeAsync();
        f.Settings.Fail = true;
        f.Model.ChromeSource = new("chrome", "synthetic Chrome");
        f.Model.ChromeEnabled = true;
        await Run(f.Model.SaveSources);
        Assert.Contains("操作失敗", f.Model.Message);
        Assert.Contains("尚未確認", f.Model.ChromeStatus);
        Assert.Equal("Telegram.TelegramDesktop", f.Model.ConfirmedSource);
    });

    [Fact]
    public Task DraftCheckboxDoesNotPretendToBeSavedAndReopenRestoresMapping() => OnUi(async () =>
    {
        await using var f = new Fixture();
        await f.Model.InitializeAsync();
        f.Model.ChromeSource = new("chrome", "synthetic Chrome");
        f.Model.ChromeEnabled = true;
        Assert.Contains("尚未確認", f.Model.ChromeStatus);
        await Run(f.Model.SaveSources);
        Assert.Contains("已啟用", f.Model.ChromeStatus);
        Assert.Contains("Worker 白名單", f.Model.ChromeStatus);
        var reopened = f.NewModel();
        await reopened.InitializeAsync();
        Assert.True(reopened.ChromeEnabled);
        Assert.Equal("chrome", reopened.ChromeSource!.Id);
        Assert.Equal("Telegram.TelegramDesktop", reopened.ConfirmedSource);
    });

    private static async Task Run(AsyncCommand command)
    {
        command.Execute(null);
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!command.CanExecute(null))
        {
            if (DateTime.UtcNow > deadline) throw new TimeoutException("UI command did not finish");
            await Task.Delay(10);
        }
    }
    private static Task OnUi(Func<Task> action)
    {
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            var dispatcher = Dispatcher.CurrentDispatcher;
            dispatcher.BeginInvoke(new Action(async () =>
            {
                try { await action(); completion.TrySetResult(); }
                catch (Exception error) { completion.TrySetException(error); }
                finally { dispatcher.BeginInvokeShutdown(DispatcherPriority.Background); }
            }));
            Dispatcher.Run();
        });
        thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        return completion.Task;
    }
    private sealed class Fixture : IAsyncDisposable
    {
        public Store Settings { get; } = new();
        private readonly Source _source = new();
        private readonly HttpClient _http = new(); // Never configured or started; no network requests.
        private readonly CloudAgentService _cloud;
        public AgentController Agent { get; }
        public MainViewModel Model { get; }
        public Fixture()
        {
            var clock = new SystemClock();
            Agent = new(_source, new Local(), new BoundedNotificationDeduplicator(), new ConfirmedTelegramSourceMatcher(), clock, new Log());
            _cloud = new(new(_http, clock, new AsyncDelay()), new Local(), Agent.GetStatus, clock, "test");
            Model = NewModel();
        }
        public MainViewModel NewModel() => new(Agent, _source, Settings, Dispatcher.CurrentDispatcher, _cloud, new CloudStore());
        public async ValueTask DisposeAsync() { await _cloud.DisposeAsync(); await Agent.DisposeAsync(); _http.Dispose(); }
    }
    private sealed class Store : ISettingsStore
    {
        public AgentSettings Value { get; private set; } = new("Telegram.TelegramDesktop");
        public int Writes { get; private set; }
        public bool Fail { get; set; }
        public bool FailLoad { get; set; }
        public Task<AgentSettings> LoadAsync(CancellationToken token) => FailLoad ? throw new IOException("Synthetic read failure") : Task.FromResult(Value);
        public Task SaveAsync(AgentSettings settings, CancellationToken token)
        {
            if (Fail) throw new IOException("Synthetic save failure");
            Writes++; Value = settings; return Task.CompletedTask;
        }
    }
    private sealed class CloudStore : ICloudSettingsStore
    {
        public Task<CloudOptions?> LoadAsync(CancellationToken token) => Task.FromResult<CloudOptions?>(null);
        public Task SaveAsync(CloudOptions options, CancellationToken token) => throw new InvalidOperationException("Unexpected cloud write");
    }
    private sealed class Local : IAlertDispatcher { public Task DispatchAsync(WorkAlertEvent alert, CancellationToken token) => Task.CompletedTask; }
    private sealed class Log : ISafeLog { public void Write(string code, NotificationMetadata? notification = null) { } }
    private sealed class Source : INotificationSource
    {
        public event Action<NotificationMetadata>? Added { add { } remove { } }
        public event Action<string>? Faulted { add { } remove { } }
        public NotificationAccess GetAccess() => NotificationAccess.Allowed;
        public Task<NotificationAccess> RequestAccessAsync() => Task.FromResult(GetAccess());
        public void Start() { }
        public void Stop() { }
        public void Dispose() { }
        public Task<IReadOnlyList<NotificationMetadata>> SnapshotAsync(CancellationToken token) => Task.FromResult<IReadOnlyList<NotificationMetadata>>([]);
    }
}
