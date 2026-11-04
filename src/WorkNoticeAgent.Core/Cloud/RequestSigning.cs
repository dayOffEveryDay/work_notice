using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace WorkNoticeAgent.Core.Cloud;

public static class RequestSigning
{
    public static string Hex(ReadOnlySpan<byte> value) => Convert.ToHexStringLower(value);
    public static string Sign(string method, string pathname, string deviceId, string timestamp, string nonce, byte[] body, string secret)
    {
        var canonical = string.Join('\n', method.ToUpperInvariant(), pathname, deviceId, timestamp, nonce, Hex(SHA256.HashData(body)));
        return "v1=" + Hex(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(canonical)));
    }
    public static string EventId(WorkAlertEvent alert, string deviceId)
    {
        // UTF-8 byte-length prefix keeps arbitrary source identifiers unambiguous.
        var parts = new[] { deviceId, alert.SourceAppId, alert.WindowsNotificationId.ToString(CultureInfo.InvariantCulture), Utc(alert.CreatedAtUtc) };
        // Preserve existing Telegram IDs across upgrade; new sources have explicit namespaces.
        if (alert.Source != "TELEGRAM") parts = [alert.Source, .. parts];
        var canonical = string.Concat(parts.Select(value => Encoding.UTF8.GetByteCount(value).ToString(CultureInfo.InvariantCulture) + ":" + value));
        return Hex(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)));
    }
    public static string Utc(DateTimeOffset instant) => instant.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture);
}
