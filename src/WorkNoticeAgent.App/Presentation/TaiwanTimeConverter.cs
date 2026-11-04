using System;
using System.Globalization;
using System.Windows.Data;

namespace WorkNoticeAgent.App.Presentation;

public sealed class TaiwanTimeConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture) =>
        value is DateTimeOffset instant ? TaiwanTimeDisplay.Format(instant) : string.Empty;

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) =>
        throw new NotSupportedException("Event timestamps are read-only.");
}
