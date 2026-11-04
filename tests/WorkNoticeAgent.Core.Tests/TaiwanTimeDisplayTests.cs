using System.Globalization;
using System.Text.Json;
using WorkNoticeAgent.App.Presentation;
using WorkNoticeAgent.Core;
using Xunit;

namespace WorkNoticeAgent.Core.Tests;

public sealed class TaiwanTimeDisplayTests
{
    [Theory]
    [InlineData("2026-11-02T03:56:31+00:00", "2026-11-02 11:56:31 +08:00")]
    [InlineData("2026-11-02T20:56:31+00:00", "2026-11-03 04:56:31 +08:00")]
    [InlineData("2026-11-02T11:56:31+08:00", "2026-11-02 11:56:31 +08:00")]
    [InlineData("2026-11-01T22:56:31-05:00", "2026-11-02 11:56:31 +08:00")]
    public void FormatUsesTaiwanTimeAndPreservesTheInstant(string input, string expected)
    {
        var instant = DateTimeOffset.Parse(input, CultureInfo.InvariantCulture);
        Assert.Equal(expected, TaiwanTimeDisplay.Format(instant));
        var displayed = TaiwanTimeDisplay.ToTaiwanTime(instant);
        Assert.Equal(TimeSpan.FromHours(8), displayed.Offset);
        Assert.Equal(instant.UtcTicks, displayed.UtcTicks);
        Assert.Equal(expected, TaiwanTimeDisplay.Format(displayed)); // already converted: no extra eight hours
    }

    [Fact]
    public void DisplayDoesNotChangeUtcEventOrFutureDispatcherPayload()
    {
        var utc = new DateTimeOffset(2026, 11, 2, 3, 56, 31, TimeSpan.Zero);
        var alert = new WorkAlertEvent(Guid.NewGuid(), "TELEGRAM", "tg", 1, utc, utc, "key");
        var diagnostic = new DiagnosticEvent(utc, new("tg", "Telegram", 1, utc), "已處理");
        var originalPayload = JsonSerializer.Serialize(alert);
        Assert.Equal("2026-11-02 11:56:31 +08:00", TaiwanTimeDisplay.Format(diagnostic.Time));
        Assert.Equal("2026-11-02 11:56:31 +08:00", TaiwanTimeDisplay.Format(alert.CreatedAtUtc));
        Assert.Equal(originalPayload, JsonSerializer.Serialize(alert));
        Assert.Equal(TimeSpan.Zero, diagnostic.Time.Offset);
        Assert.Equal(TimeSpan.Zero, alert.CreatedAtUtc.Offset);
        Assert.Equal(TimeSpan.Zero, alert.DetectedAtUtc.Offset);
    }
}
