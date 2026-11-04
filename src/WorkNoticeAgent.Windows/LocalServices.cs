using System.Text.Json;
using WorkNoticeAgent.Core;

namespace WorkNoticeAgent.Windows;

public sealed class JsonSettingsStore(string directory) : ISettingsStore
{
    private readonly string _path = Path.Combine(directory, "settings.json");
    public async Task<AgentSettings> LoadAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(_path)) return new();
        await using var stream = File.OpenRead(_path);
        return await JsonSerializer.DeserializeAsync<AgentSettings>(stream, cancellationToken: cancellationToken) ?? new();
    }
    public async Task SaveAsync(AgentSettings settings, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var temporary = _path + ".tmp";
        await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(settings), cancellationToken);
        File.Move(temporary, _path, true);
    }
}

public sealed class RollingSafeLog(string directory) : ISafeLog
{
    private readonly object _sync = new();
    public void Write(string code, NotificationMetadata? notification = null)
    {
        // Only explicitly allowed fields. JSON escapes newlines in source identifiers.
        lock (_sync)
        {
            try
            {
                Directory.CreateDirectory(directory);
                var path = Path.Combine(directory, "agent.jsonl");
                if (File.Exists(path) && new FileInfo(path).Length >= 1_048_576)
                    File.Move(path, path + ".1", true);
                File.AppendAllText(path, JsonSerializer.Serialize(new
                {
                    time = DateTimeOffset.UtcNow, code, sourceAppId = notification?.SourceAppId,
                    notificationId = notification?.Id, createdAtUtc = notification?.CreatedAtUtc
                }) + Environment.NewLine);
            }
            catch (IOException) { System.Diagnostics.Debug.WriteLine("SafeLog IO failure"); }
            catch (UnauthorizedAccessException) { System.Diagnostics.Debug.WriteLine("SafeLog access failure"); }
        }
    }
}

public sealed class LocalDebugAlertDispatcher(ISafeLog log) : IAlertDispatcher
{
    public event Action<WorkAlertEvent>? Dispatched;
    public Task DispatchAsync(WorkAlertEvent alert, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        log.Write("LocalAlert", new(alert.SourceAppId, "", alert.WindowsNotificationId, alert.CreatedAtUtc));
        Dispatched?.Invoke(alert);
        return Task.CompletedTask;
    }
}
