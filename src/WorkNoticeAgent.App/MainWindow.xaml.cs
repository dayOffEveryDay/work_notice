using System.ComponentModel;
using System.Windows;

namespace WorkNoticeAgent.App;

public partial class MainWindow : Window
{
    private bool _explained;
    public bool Exiting { get; set; }
    public MainWindow() => InitializeComponent();
    protected override void OnClosing(CancelEventArgs e)
    {
        if (!Exiting)
        {
            e.Cancel = true;
            if (!_explained)
            {
                _explained = true;
                MessageBox.Show(this, "程式仍在系統匣執行，並依目前模式處理通知。請從系統匣選單選擇「結束程式」退出。", "Work Notice Agent");
            }
            Hide();
        }
        base.OnClosing(e);
    }
    public void ShowMain() { Show(); WindowState = WindowState.Normal; Activate(); }
    private async void SaveCloud_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not System.Windows.Controls.Button button || DataContext is not MainViewModel model) return;
        button.IsEnabled = false;
        try { await model.SaveCloudAsync(CloudSecret.Password); }
        finally { CloudSecret.Clear(); button.IsEnabled = true; }
    }
}
