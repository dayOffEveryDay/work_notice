namespace WorkNoticeAgent.Core;

// Controller serializes access. No notification text is retained.
public sealed class BoundedNotificationDeduplicator(int capacity = 4096) : INotificationDeduplicator
{
    private readonly int _capacity = capacity > 0 ? capacity : throw new ArgumentOutOfRangeException(nameof(capacity));
    private readonly HashSet<string> _keys = [];
    private readonly Queue<string> _order = new();
    public bool Remember(NotificationMetadata notification)
    {
        var key = notification.DeduplicationKey;
        if (!_keys.Add(key)) return false;
        _order.Enqueue(key);
        while (_order.Count > _capacity) _keys.Remove(_order.Dequeue());
        return true;
    }
}
