using WorkNoticeAgent.Core;
using Xunit;

namespace WorkNoticeAgent.Core.Tests;

public sealed class AgentTests
{
    [Fact]
    public async Task MonitoringTelegramDispatchesExactlyOnce()
    {
        await using var f = await Fixture.Create();
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        var notification = f.New();
        await f.Agent.ProcessAsync(notification);
        await f.Agent.ProcessAsync(notification);
        var alert = Assert.Single(f.Dispatcher.Alerts);
        Assert.Equal("TELEGRAM", alert.Source);
        Assert.Equal(notification.DeduplicationKey, alert.DeduplicationKey);
        Assert.NotEqual(Guid.Empty, alert.EventId);
    }
    [Fact]
    public async Task DifferentNewNotificationsDispatchIndependently()
    {
        await using var f = await Fixture.Create();
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        await f.Agent.ProcessAsync(f.New(1));
        await f.Agent.ProcessAsync(f.New(2));
        Assert.Equal(2, f.Dispatcher.Alerts.Count);
    }
    [Fact]
    public async Task OtherAppWithTelegramDisplayNameIsIgnored()
    {
        await using var f = await Fixture.Create();
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        await f.Agent.ProcessAsync(f.New() with { SourceAppId = "browser", DisplayName = "Telegram" });
        Assert.Empty(f.Dispatcher.Alerts);
    }
    [Fact]
    public async Task StandbyDoesNotDispatchOrReplayOnMonitoring()
    {
        await using var f = await Fixture.Create();
        var old = f.New();
        await f.Agent.ProcessAsync(old);
        f.Source.Current = [old];
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        await f.Agent.ProcessAsync(old);
        Assert.Empty(f.Dispatcher.Alerts);
    }
    [Fact]
    public async Task RestartDefaultsToStandbyAndNeverReplaysExistingNotification()
    {
        await using var f = await Fixture.Create(existing: true);
        Assert.Equal(AgentMode.Standby, f.Agent.GetStatus().Mode);
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        await f.Agent.ProcessAsync(f.Source.Current[0]);
        Assert.Empty(f.Dispatcher.Alerts);
    }
    [Fact]
    public async Task RevokedPermissionBlocksDispatchAndMarksUnhealthy()
    {
        await using var f = await Fixture.Create();
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        f.Source.Access = NotificationAccess.Denied;
        await f.Agent.ProcessAsync(f.New());
        Assert.Empty(f.Dispatcher.Alerts);
        Assert.Equal(ListenerHealth.AccessDenied, f.Agent.GetStatus().Health);
        Assert.Equal(AgentMode.Standby, f.Agent.GetStatus().Mode);
    }
    [Fact]
    public async Task SubscriptionFailureDoesNotPretendToMonitor()
    {
        await using var f = await Fixture.Create();
        f.Source.FailSubscription = true;
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        Assert.Equal(ListenerHealth.Error, f.Agent.GetStatus().Health);
        Assert.Equal(AgentMode.Standby, f.Agent.GetStatus().Mode);
        await f.Agent.ProcessAsync(f.New());
        Assert.Empty(f.Dispatcher.Alerts);
    }
    [Fact]
    public async Task ParseFailureDiagnosticDoesNotBlockSubsequentNotification()
    {
        await using var f = await Fixture.Create();
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        f.Source.ParseFailure();
        await f.Agent.ProcessAsync(f.New());
        Assert.Single(f.Dispatcher.Alerts);
        Assert.Equal(ListenerHealth.Ready, f.Agent.GetStatus().Health);
    }
    [Fact]
    public async Task EventsDuringBaselineAreSuppressedEvenIfTheyArriveAfterSnapshotWasCaptured()
    {
        await using var f = await Fixture.Create();
        Task? queued = null;
        f.Source.DuringSnapshot = () => queued = f.Agent.ProcessAsync(f.New());
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        await queued!;
        Assert.Empty(f.Dispatcher.Alerts);
    }
    [Fact]
    public async Task ResumeBaselineSuppressesSleepingNotificationsAndAllowsNewOnes()
    {
        await using var f = await Fixture.Create();
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        f.Agent.Suspend();
        var sleeping = f.New(10);
        await f.Agent.ProcessAsync(sleeping);
        f.Source.Current = [sleeping];
        await f.Agent.RefreshAsync();
        await f.Agent.ProcessAsync(sleeping);
        await f.Agent.ProcessAsync(f.New(11));
        Assert.Single(f.Dispatcher.Alerts);
    }
    [Fact]
    public async Task MissingConfirmedSourceCannotEnterMonitoring()
    {
        await using var f = await Fixture.Create();
        await f.Agent.InitializeAsync(null);
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        Assert.Equal(AgentMode.Standby, f.Agent.GetStatus().Mode);
    }
    [Fact]
    public void CacheIsBoundedAndIncludesSourceIdAndCreationTime()
    {
        var cache = new BoundedNotificationDeduplicator(2);
        var n = new NotificationMetadata("a", "", 1, DateTimeOffset.UnixEpoch);
        Assert.True(cache.Remember(n));
        Assert.False(cache.Remember(n));
        Assert.True(cache.Remember(n with { SourceAppId = "b" }));
        Assert.True(cache.Remember(n with { CreatedAtUtc = n.CreatedAtUtc.AddTicks(1) }));
        Assert.True(cache.Remember(n)); // oldest entry evicted
    }
    [Fact]
    public async Task CreationTimeWatermarkPreventsReplayAfterCacheEviction()
    {
        await using var f = await Fixture.Create(existing: true);
        var old = f.Source.Current[0];
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        for (uint i = 0; i < 5; i++) await f.Agent.ProcessAsync(f.New(i + 20));
        await f.Agent.ProcessAsync(old);
        Assert.Equal(5, f.Dispatcher.Alerts.Count);
    }
    [Fact]
    public async Task SourceChangeRequiresRearmingAndUsesNewIdentity()
    {
        await using var f = await Fixture.Create();
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        await f.Agent.ConfirmSourceAsync("new-telegram");
        Assert.Equal(AgentMode.Standby, f.Agent.GetStatus().Mode);
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        await f.Agent.ProcessAsync(f.New(1));
        await f.Agent.ProcessAsync(f.New(2) with { SourceAppId = "new-telegram" });
        Assert.Equal("new-telegram", Assert.Single(f.Dispatcher.Alerts).SourceAppId);
    }
    [Theory]
    [InlineData(NotificationAccess.Denied, ListenerHealth.AccessDenied)]
    [InlineData(NotificationAccess.Unspecified, ListenerHealth.AccessRequired)]
    public async Task InitialPermissionIsVisible(NotificationAccess access, ListenerHealth health)
    {
        await using var f = await Fixture.Create();
        f.Source.Access = access;
        await f.Agent.RefreshAsync();
        Assert.Equal(health, f.Agent.GetStatus().Health);
        Assert.Equal(AgentMode.Standby, f.Agent.GetStatus().Mode);
    }

    [Fact]
    public async Task ReconfirmSameSourceWhileMonitoringKeepsModeAndPendingNewEvent()
    {
        await using var f = await Fixture.Create();
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        var pending = f.New();
        var snapshots = f.Source.SnapshotCount;
        var modeChanges = new List<AgentMode>();
        f.Agent.Changed += () => modeChanges.Add(f.Agent.GetStatus().Mode);
        await f.Agent.ConfirmSourceAsync("tg");
        Assert.Equal(AgentMode.Monitoring, f.Agent.GetStatus().Mode);
        Assert.Equal(snapshots, f.Source.SnapshotCount);
        Assert.Empty(modeChanges);
        await f.Agent.ProcessAsync(pending);
        await f.Agent.ProcessAsync(pending);
        Assert.Single(f.Dispatcher.Alerts);
        Assert.Equal(AgentMode.Monitoring, f.Agent.GetStatus().Mode);
    }

    [Fact]
    public async Task ReconfirmSameSourceWhileStandbyDoesNotRebuildBaseline()
    {
        await using var f = await Fixture.Create();
        var snapshots = f.Source.SnapshotCount;
        await f.Agent.ConfirmSourceAsync("tg");
        Assert.Equal(AgentMode.Standby, f.Agent.GetStatus().Mode);
        Assert.Equal(snapshots, f.Source.SnapshotCount);
        await f.Agent.ProcessAsync(f.New());
        Assert.Empty(f.Dispatcher.Alerts);
    }

    [Fact]
    public async Task FirstSourceConfirmationStaysStandbyAndEstablishesBaseline()
    {
        await using var f = await Fixture.Create();
        await f.Agent.InitializeAsync(null);
        var snapshots = f.Source.SnapshotCount;
        var existing = f.New();
        f.Source.Current = [existing];
        await f.Agent.ConfirmSourceAsync("tg");
        Assert.Equal(AgentMode.Standby, f.Agent.GetStatus().Mode);
        Assert.Equal(snapshots + 1, f.Source.SnapshotCount);
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        await f.Agent.ProcessAsync(existing);
        Assert.Empty(f.Dispatcher.Alerts);
    }

    [Fact]
    public async Task ChangingSourceBaselinesExistingNewSourceNotificationsWithoutReplay()
    {
        await using var f = await Fixture.Create();
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        var old = f.New(81) with { SourceAppId = "new-tg" };
        f.Source.Current = [old];
        var snapshots = f.Source.SnapshotCount;
        await f.Agent.ConfirmSourceAsync("new-tg");
        Assert.Equal(AgentMode.Standby, f.Agent.GetStatus().Mode);
        Assert.Equal(snapshots + 1, f.Source.SnapshotCount);
        await f.Agent.ProcessAsync(old);
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        await f.Agent.ProcessAsync(old);
        Assert.Empty(f.Dispatcher.Alerts);
        var fresh = f.New(82) with { SourceAppId = "new-tg" };
        await f.Agent.ProcessAsync(fresh);
        await f.Agent.ProcessAsync(fresh);
        await f.Agent.ProcessAsync(f.New(83)); // former Telegram source is no longer trusted
        Assert.Equal("new-tg", Assert.Single(f.Dispatcher.Alerts).SourceAppId);
        await f.Agent.ProcessAsync(old); // old key evicted from the bounded cache; watermark still blocks replay
        Assert.Single(f.Dispatcher.Alerts);
    }

    [Fact]
    public async Task RefreshWhileMonitoringNeverPublishesStandbyAndDoesNotReplay()
    {
        await using var f = await Fixture.Create();
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        var old = f.New();
        f.Source.Current = [old];
        var modes = new List<AgentMode>();
        f.Agent.Changed += () => modes.Add(f.Agent.GetStatus().Mode);
        f.Source.DuringSnapshot = () => Assert.Equal(AgentMode.Monitoring, f.Agent.GetStatus().Mode);
        await f.Agent.RefreshAsync();
        Assert.NotEmpty(modes);
        Assert.All(modes, mode => Assert.Equal(AgentMode.Monitoring, mode));
        await f.Agent.ProcessAsync(old);
        Assert.Empty(f.Dispatcher.Alerts);
        await f.Agent.ProcessAsync(f.New(2));
        Assert.Single(f.Dispatcher.Alerts);
    }

    [Fact]
    public async Task RefreshWhileStandbyStaysStandby()
    {
        await using var f = await Fixture.Create();
        await f.Agent.RefreshAsync();
        Assert.Equal(AgentMode.Standby, f.Agent.GetStatus().Mode);
        await f.Agent.ProcessAsync(f.New());
        Assert.Empty(f.Dispatcher.Alerts);
    }

    [Fact]
    public async Task RefreshWithRevokedAccessStillStopsMonitoring()
    {
        await using var f = await Fixture.Create();
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        f.Source.Access = NotificationAccess.Denied;
        await f.Agent.RefreshAsync();
        Assert.Equal(AgentMode.Standby, f.Agent.GetStatus().Mode);
        Assert.Equal(ListenerHealth.AccessDenied, f.Agent.GetStatus().Health);
        await f.Agent.ProcessAsync(f.New());
        Assert.Empty(f.Dispatcher.Alerts);
    }

    [Fact]
    public async Task RefreshSnapshotFailureStillStopsMonitoringAndShowsError()
    {
        await using var f = await Fixture.Create();
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        f.Source.FailSnapshot = true;
        await f.Agent.RefreshAsync();
        Assert.Equal(AgentMode.Standby, f.Agent.GetStatus().Mode);
        Assert.Equal(ListenerHealth.Error, f.Agent.GetStatus().Health);
        await f.Agent.ProcessAsync(f.New());
        Assert.Empty(f.Dispatcher.Alerts);
    }

    [Fact]
    public async Task ThreeExactMappingsDispatchDistinctSourcesAndUnknownIsIgnored()
    {
        await using var f = await Fixture.Create();
        await f.Agent.ConfigureSourcesAsync(new("tg", true, new("chrome", true), new("brave", true)));
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        foreach (var id in new[] { "tg", "chrome", "brave", "unknown", "CHROME" })
            await f.Agent.ProcessAsync(f.New() with { SourceAppId = id, DisplayName = "Telegram" });
        Assert.Equal(new[] { "TELEGRAM", "LARK_A_CHROME", "LARK_B_BRAVE" }, f.Dispatcher.Alerts.Select(a => a.Source));
    }

    [Fact]
    public async Task DisabledTelegramRemainsConfirmedButDoesNotDispatch()
    {
        await using var f = await Fixture.Create();
        await f.Agent.ConfigureSourcesAsync(new("tg", false, new("chrome", true)));
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        await f.Agent.ProcessAsync(f.New());
        await f.Agent.ProcessAsync(f.New(2) with { SourceAppId = "chrome" });
        Assert.True(f.Agent.GetStatus().TelegramSourceConfirmed);
        Assert.Equal("LARK_A_CHROME", Assert.Single(f.Dispatcher.Alerts).Source);
    }

    [Fact]
    public async Task ChangedMappingRebaselinesWithoutOldNotificationReplay()
    {
        await using var f = await Fixture.Create();
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        var old = f.New() with { SourceAppId = "chrome" };
        f.Source.Current = [old];
        await f.Agent.ConfigureSourcesAsync(new("tg", true, new("chrome", true)));
        Assert.Equal(AgentMode.Standby, f.Agent.GetStatus().Mode);
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        await f.Agent.ProcessAsync(old);
        Assert.Empty(f.Dispatcher.Alerts);
        var fresh = f.New(2) with { SourceAppId = "chrome" };
        await f.Agent.ProcessAsync(fresh);
        await f.Agent.ProcessAsync(fresh);
        Assert.Single(f.Dispatcher.Alerts);
    }

    [Fact]
    public async Task SameSettingsAndTelegramReconfirmationKeepBrowserMappingAndMonitoring()
    {
        await using var f = await Fixture.Create();
        var settings = new AgentSettings("tg", true, new("chrome", true), new("brave", true));
        await f.Agent.ConfigureSourcesAsync(settings);
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        var snapshots = f.Source.SnapshotCount;
        await f.Agent.ConfigureSourcesAsync(settings with { LarkChrome = new("chrome", true) });
        await f.Agent.ConfirmSourceAsync("tg");
        Assert.Equal(snapshots, f.Source.SnapshotCount);
        Assert.Equal(AgentMode.Monitoring, f.Agent.GetStatus().Mode);
        await f.Agent.ProcessAsync(f.New() with { SourceAppId = "brave" });
        Assert.Equal("LARK_B_BRAVE", Assert.Single(f.Dispatcher.Alerts).Source);
    }

    [Fact]
    public async Task StandbyBrowserNotificationNeverReplaysWhenMonitoringStarts()
    {
        await using var f = await Fixture.Create();
        await f.Agent.ConfigureSourcesAsync(new("tg", true, new("chrome", true)));
        var old = f.New() with { SourceAppId = "chrome" };
        await f.Agent.ProcessAsync(old);
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        await f.Agent.ProcessAsync(old);
        Assert.Empty(f.Dispatcher.Alerts);
    }

    [Fact]
    public void AmbiguousOrUnmappedBrowserSettingsAreRejected()
    {
        Assert.Throws<ArgumentException>(() => new AgentSettings("tg", true, new("tg", true)).Validate());
        Assert.Throws<ArgumentException>(() => new AgentSettings("tg", true, new("browser", true), new("browser", false)).Validate());
        Assert.Throws<ArgumentException>(() => new AgentSettings("tg", true, new(null, true)).Validate());
    }

    [Fact]
    public async Task AllDisabledSourcesCannotStartMonitoring()
    {
        await using var f = await Fixture.Create();
        await f.Agent.ConfigureSourcesAsync(new("tg", false));
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        Assert.Equal(AgentMode.Standby, f.Agent.GetStatus().Mode);
        Assert.NotNull(f.Agent.GetStatus().Error);
    }

    [Theory]
    [InlineData("tg")][InlineData("chrome")][InlineData("brave")]
    public async Task EachSourceSwitchIsIndependentAndBrowserOnlyHealthIsTruthful(string disabled)
    {
        await using var f = await Fixture.Create();
        await f.Agent.ConfigureSourcesAsync(new("tg", disabled != "tg", new("chrome", disabled != "chrome"), new("brave", disabled != "brave")));
        await f.Agent.SetModeAsync(AgentMode.Monitoring);
        f.Clock.UtcNow += TimeSpan.FromSeconds(1);
        foreach (var app in new[] { "tg", "chrome", "brave" })
        {
            var n = new NotificationMetadata(app, "same display", 42, f.Clock.UtcNow);
            await f.Agent.ProcessAsync(n);
            await f.Agent.ProcessAsync(n);
        }
        Assert.Equal(2, f.Dispatcher.Alerts.Count);
        Assert.DoesNotContain(f.Dispatcher.Alerts, a => a.SourceAppId == disabled);
        Assert.Equal(2, f.Agent.GetStatus().EnabledSources!.Count);
    }

    private sealed class Fixture : IAsyncDisposable
    {
        public FakeSource Source { get; } = new();
        public FakeDispatcher Dispatcher { get; } = new();
        public FakeClock Clock { get; } = new();
        public AgentController Agent { get; }
        private Fixture() => Agent = new(Source, Dispatcher, new BoundedNotificationDeduplicator(2), new ConfirmedTelegramSourceMatcher(), Clock, new NullLog());
        public static async Task<Fixture> Create(bool existing = false)
        {
            var f = new Fixture();
            if (existing) f.Source.Current = [new("tg", "Telegram", 99, f.Clock.UtcNow.AddMinutes(-5))];
            await f.Agent.InitializeAsync("tg");
            return f;
        }
        public NotificationMetadata New(uint id = 1)
        {
            Clock.UtcNow = Clock.UtcNow.AddSeconds(1);
            return new("tg", "Telegram", id, Clock.UtcNow);
        }
        public ValueTask DisposeAsync() => Agent.DisposeAsync();
    }
    private sealed class FakeClock : IClock { public DateTimeOffset UtcNow { get; set; } = DateTimeOffset.Parse("2026-11-01T00:00:00Z"); }
    private sealed class NullLog : ISafeLog { public void Write(string code, NotificationMetadata? notification = null) { } }
    private sealed class FakeDispatcher : IAlertDispatcher
    {
        public List<WorkAlertEvent> Alerts { get; } = [];
        public Task DispatchAsync(WorkAlertEvent alert, CancellationToken cancellationToken) { Alerts.Add(alert); return Task.CompletedTask; }
    }
    private sealed class FakeSource : INotificationSource
    {
        public event Action<NotificationMetadata>? Added;
        public event Action<string>? Faulted;
        public NotificationAccess Access { get; set; } = NotificationAccess.Allowed;
        public IReadOnlyList<NotificationMetadata> Current { get; set; } = [];
        public bool FailSubscription { get; set; }
        public bool FailSnapshot { get; set; }
        public int SnapshotCount { get; private set; }
        public Action? DuringSnapshot { get; set; }
        public NotificationAccess GetAccess() => Access;
        public Task<NotificationAccess> RequestAccessAsync() => Task.FromResult(Access);
        public void Start() { if (FailSubscription) throw new InvalidOperationException(); }
        public void Stop() { }
        public Task<IReadOnlyList<NotificationMetadata>> SnapshotAsync(CancellationToken cancellationToken)
        {
            SnapshotCount++;
            if (FailSnapshot) throw new InvalidOperationException();
            DuringSnapshot?.Invoke();
            return Task.FromResult(Current);
        }
        public void ParseFailure() => Faulted?.Invoke("NotificationParse:0x80004005");
        public void Emit(NotificationMetadata notification) => Added?.Invoke(notification);
        public void Dispose() { }
    }
}
