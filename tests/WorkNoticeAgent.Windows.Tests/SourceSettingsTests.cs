using WorkNoticeAgent.Core;
using WorkNoticeAgent.Windows;
using Xunit;

namespace WorkNoticeAgent.Windows.Tests;

public sealed class SourceSettingsTests
{
    [Fact]
    public async Task UnrecognizedSettingsFieldsSurviveSourceEditing()
    {
        var directory = Path.Combine(Path.GetTempPath(), "WorkNoticeSources-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            await File.WriteAllTextAsync(Path.Combine(directory, "settings.json"), "{\"TelegramAppId\":\"Telegram.TelegramDesktop\",\"FutureSetting\":{\"value\":42}}");
            var store = new JsonSettingsStore(directory);
            var original = await store.LoadAsync(CancellationToken.None);
            await store.SaveAsync(original with { LarkChrome = new("synthetic-chrome", true) }, CancellationToken.None);
            var reloaded = await store.LoadAsync(CancellationToken.None);
            Assert.Equal(42, reloaded.AdditionalSettings!["FutureSetting"].GetProperty("value").GetInt32());
            Assert.Equal(original.TelegramAppId, reloaded.TelegramAppId);
        }
        finally { File.Delete(Path.Combine(directory, "settings.json")); Directory.Delete(directory); }
    }

    [Fact]
    public async Task LegacySettingsPreserveTelegramAndDefaultBrowsersOffWithoutTouchingCloud()
    {
        var directory = Path.Combine(Path.GetTempPath(), "WorkNoticeSources-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var path = Path.Combine(directory, "settings.json");
            await File.WriteAllTextAsync(path, "{\"TelegramAppId\":\"Telegram.TelegramDesktop\"}");
            var cloudPath = Path.Combine(directory, "cloud-settings.json");
            const string sentinel = "synthetic protected cloud settings: must remain untouched";
            await File.WriteAllTextAsync(cloudPath, sentinel);
            var store = new JsonSettingsStore(directory);
            var original = await store.LoadAsync(CancellationToken.None);
            Assert.Equal("Telegram.TelegramDesktop", original.TelegramAppId);
            Assert.True(original.TelegramEnabled);
            Assert.Null(original.LarkChrome);
            Assert.Null(original.LarkBrave);
            var updated = original with { LarkChrome = new("chrome-test", true), LarkBrave = new("brave-test", false) };
            await store.SaveAsync(updated, CancellationToken.None);
            Assert.Equal(updated, await store.LoadAsync(CancellationToken.None));
            await store.SaveAsync(updated with { TelegramEnabled = false, LarkChrome = updated.LarkChrome! with { Enabled = false } }, CancellationToken.None);
            var disabled = await store.LoadAsync(CancellationToken.None);
            Assert.Equal(original.TelegramAppId, disabled.TelegramAppId);
            Assert.Equal("chrome-test", disabled.LarkChrome!.AppId);
            Assert.Equal(sentinel, await File.ReadAllTextAsync(cloudPath));
        }
        finally
        {
            File.Delete(Path.Combine(directory, "settings.json"));
            File.Delete(Path.Combine(directory, "cloud-settings.json"));
            Directory.Delete(directory);
        }
    }
}
