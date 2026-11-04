using System.Security.Cryptography;
using System.Text.Json;
using WorkNoticeAgent.Core.Cloud;
using WorkNoticeAgent.Windows;
using Xunit;

namespace WorkNoticeAgent.Windows.Tests;

public sealed class ProtectedSettingsTests
{
    [Fact]
    public async Task RealCurrentUserDpapiRoundTripNeverStoresPlaintextSecret()
    {
        var directory = Path.Combine(Path.GetTempPath(), "WorkNoticeAgent-" + Guid.NewGuid().ToString("N"));
        var store = new ProtectedCloudSettingsStore(directory);
        var secret = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        try
        {
            Assert.Null(await store.LoadAsync(CancellationToken.None));
            await store.SaveAsync(new("https://worker.example", "home-windows", secret), CancellationToken.None);
            var file = await File.ReadAllTextAsync(Path.Combine(directory, "cloud-settings.json"));
            Assert.DoesNotContain(secret, file);
            var loaded = await store.LoadAsync(CancellationToken.None);
            Assert.Equal(secret, loaded!.Secret);
            Assert.Equal("home-windows", loaded.DeviceId);
            var document = JsonDocument.Parse(file);
            Assert.NotEqual(secret, document.RootElement.GetProperty("ProtectedSecret").GetString());
        }
        finally { if (File.Exists(Path.Combine(directory, "cloud-settings.json"))) File.Delete(Path.Combine(directory, "cloud-settings.json")); if (Directory.Exists(directory)) Directory.Delete(directory); }
    }
    [Fact]
    public async Task CorruptedProtectedSecretFailsInsteadOfUsingAnUnprotectedFallback()
    {
        var directory = Path.Combine(Path.GetTempPath(), "WorkNoticeAgent-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, "cloud-settings.json");
        try
        {
            await File.WriteAllTextAsync(path, JsonSerializer.Serialize(new { Endpoint = "https://worker.example", DeviceId = "home-windows", ProtectedSecret = Convert.ToBase64String(RandomNumberGenerator.GetBytes(64)) }));
            await Assert.ThrowsAsync<CryptographicException>(() => new ProtectedCloudSettingsStore(directory).LoadAsync(CancellationToken.None));
        }
        finally { File.Delete(path); Directory.Delete(directory); }
    }
}
