using Windows.ApplicationModel;
using Windows.UI.Notifications;
using Windows.UI.Notifications.Management;
using WorkNoticeAgent.Core;

namespace WorkNoticeAgent.Windows;

// Production adapter: no synthetic notifications and no access to Notification.Visual/text.
public sealed class WindowsNotificationSource : INotificationSource
{
    private UserNotificationListener? _listener;
    private long _subscription;
    private bool _subscribed;
    public event Action<NotificationMetadata>? Added;
    public event Action<string>? Faulted;
    private UserNotificationListener Listener => _listener ??= UserNotificationListener.Current;
    public static bool HasPackageIdentity()
    {
        try { return !string.IsNullOrEmpty(Package.Current.Id.Name); }
        catch (InvalidOperationException) { return false; }
    }
    private static NotificationAccess Map(UserNotificationListenerAccessStatus value) => value switch
    {
        UserNotificationListenerAccessStatus.Allowed => NotificationAccess.Allowed,
        UserNotificationListenerAccessStatus.Denied => NotificationAccess.Denied,
        _ => NotificationAccess.Unspecified
    };
    public NotificationAccess GetAccess() => Map(Listener.GetAccessStatus());
    // Invoked directly by the WPF command on its UI thread; do not wrap in Task.Run.
    public async Task<NotificationAccess> RequestAccessAsync() => Map(await Listener.RequestAccessAsync());
    public void Start()
    {
        if (_subscribed) return;
        Listener.NotificationChanged += OnChanged;
        _subscribed = true;
        Interlocked.Increment(ref _subscription);
    }
    public void Stop()
    {
        Interlocked.Increment(ref _subscription);
        if (!_subscribed) return;
        _subscribed = false;
        try { Listener.NotificationChanged -= OnChanged; }
        catch (Exception ex) { Faulted?.Invoke($"ListenerUnsubscribe:0x{ex.HResult:X8}"); }
    }
    public async Task<IReadOnlyList<NotificationMetadata>> SnapshotAsync(CancellationToken cancellationToken)
    {
        if (GetAccess() != NotificationAccess.Allowed) throw new UnauthorizedAccessException();
        var notifications = await Listener.GetNotificationsAsync(NotificationKinds.Toast).AsTask(cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        List<NotificationMetadata> result = [];
        foreach (var notification in notifications)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try { result.Add(ReadMetadata(notification)); }
            catch (Exception ex) { Faulted?.Invoke($"NotificationParse:0x{ex.HResult:X8}"); }
        }
        return result;
    }
    private void OnChanged(UserNotificationListener sender, UserNotificationChangedEventArgs args)
    {
        if (args.ChangeKind != UserNotificationChangedKind.Added) return;
        var epoch = Interlocked.Read(ref _subscription);
        try
        {
            if (GetAccess() != NotificationAccess.Allowed) { Faulted?.Invoke("ListenerAccessChanged"); return; }
            // The notification may already have been removed when Windows delivers this callback.
            var notification = sender.GetNotification(args.UserNotificationId);
            if (notification is null) return;
            NotificationMetadata metadata;
            try { metadata = ReadMetadata(notification); }
            catch (Exception ex) { Faulted?.Invoke($"NotificationParse:0x{ex.HResult:X8}"); return; }
            if (epoch == Interlocked.Read(ref _subscription)) Added?.Invoke(metadata);
        }
        catch (Exception ex) { Faulted?.Invoke($"ListenerRead:0x{ex.HResult:X8}"); }
    }
    private static NotificationMetadata ReadMetadata(UserNotification notification)
    {
        var app = notification.AppInfo;
        var id = app.AppUserModelId;
        if (string.IsNullOrWhiteSpace(id)) throw new InvalidOperationException("Missing AUMID");
        return new(id, app.DisplayInfo.DisplayName, notification.Id, notification.CreationTime.ToUniversalTime());
    }
    public void Dispose() => Stop();
}
