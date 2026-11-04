using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using WorkNoticeAgent.Core.Cloud;

namespace WorkNoticeAgent.Windows;

public sealed class ProtectedCloudSettingsStore(string directory) : ICloudSettingsStore
{
    private sealed record Stored(string Endpoint, string DeviceId, string ProtectedSecret);
    private readonly string _path = Path.Combine(directory, "cloud-settings.json");
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("WorkNoticeAgent.Cloud.v1");
    public async Task<CloudOptions?> LoadAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(_path)) return null;
        var saved = JsonSerializer.Deserialize<Stored>(await File.ReadAllTextAsync(_path, cancellationToken))
            ?? throw new InvalidDataException();
        var bytes = ProtectedData.Unprotect(Convert.FromBase64String(saved.ProtectedSecret), Entropy, DataProtectionScope.CurrentUser);
        try { return new(saved.Endpoint, saved.DeviceId, Encoding.UTF8.GetString(bytes)); }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }
    public async Task SaveAsync(CloudOptions options, CancellationToken cancellationToken)
    {
        var plain = Encoding.UTF8.GetBytes(options.Secret);
        byte[] encrypted;
        try { encrypted = ProtectedData.Protect(plain, Entropy, DataProtectionScope.CurrentUser); }
        finally { CryptographicOperations.ZeroMemory(plain); }
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var temporary = _path + ".tmp";
        await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(new Stored(options.Endpoint, options.DeviceId, Convert.ToBase64String(encrypted))), cancellationToken);
        File.Move(temporary, _path, true);
    }
}
