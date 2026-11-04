using System;
using System.Globalization;

namespace WorkNoticeAgent.App.Presentation;

// Display only: never assign converted values back to events or dispatcher DTOs.
public static class TaiwanTimeDisplay
{
    private static readonly TimeZoneInfo Taiwan = TimeZoneInfo.FindSystemTimeZoneById("Taipei Standard Time");
    public static DateTimeOffset ToTaiwanTime(DateTimeOffset instant) => TimeZoneInfo.ConvertTime(instant, Taiwan);
    public static string Format(DateTimeOffset instant) =>
        ToTaiwanTime(instant).ToString("yyyy-MM-dd HH:mm:ss zzz", CultureInfo.InvariantCulture);
}
