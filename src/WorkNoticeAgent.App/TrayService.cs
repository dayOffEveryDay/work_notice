using System;
using System.Drawing;
using System.Windows.Threading;
using System.Windows.Media.Imaging;
using WorkNoticeAgent.Core;
using Forms = System.Windows.Forms;

namespace WorkNoticeAgent.App;

public sealed class TrayService : IDisposable
{
    private readonly Forms.NotifyIcon _icon;
    private readonly AgentController _agent;
    private readonly Dispatcher _ui;
    private readonly MainWindow _window;
    private readonly Icon _standbyIcon = LoadIcon("Standby");
    private readonly Icon _monitoringIcon = LoadIcon("Monitoring");
    private readonly BitmapFrame _standbyWindowIcon = BitmapFrame.Create(IconUri("Standby"));
    private readonly BitmapFrame _monitoringWindowIcon = BitmapFrame.Create(IconUri("Monitoring"));
    private bool _disposed;
    public TrayService(MainWindow window, MainViewModel model, AgentController agent, Action exit, Dispatcher ui)
    {
        (_agent, _ui) = (agent, ui);
        _window = window;
        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("顯示主畫面", null, (_, _) => window.ShowMain());
        menu.Items.Add("監控中", null, (_, _) => model.Monitor.Execute(null));
        menu.Items.Add("待命中", null, (_, _) => model.Standby.Execute(null));
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("結束程式", null, (_, _) => exit());
        _icon = new Forms.NotifyIcon { ContextMenuStrip = menu, Visible = true };
        _icon.DoubleClick += (_, _) => window.ShowMain();
        _agent.Changed += OnChanged;
        Update();
    }
    private void OnChanged() { if (!_ui.HasShutdownStarted) _ui.BeginInvoke(Update); }
    private void Update()
    {
        if (_disposed) return;
        var status = _agent.GetStatus();
        var healthy = status.Health == ListenerHealth.Ready;
        var monitoring = healthy && status.Mode == AgentMode.Monitoring;
        _icon.Icon = monitoring ? _monitoringIcon : _standbyIcon;
        _window.Icon = monitoring ? _monitoringWindowIcon : _standbyWindowIcon;
        _icon.Text = "Work Notice Agent — " + (monitoring ? "監控中／就緒" : healthy ? "待命中／就緒" : "待命中／未就緒");
    }
    private static Uri IconUri(string name) => new($"pack://application:,,,/Assets/{name}.ico");
    private static Icon LoadIcon(string name)
    {
        using var stream = System.Windows.Application.GetResourceStream(IconUri(name))!.Stream;
        // Supply a crisp 32px HICON rather than letting a virtualized 16px metric
        // become an upscaled low-resolution tray image on high-DPI displays.
        using var icon = new Icon(stream, 32, 32);
        return (Icon)icon.Clone();
    }
    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _agent.Changed -= OnChanged;
        _icon.Visible = false;
        _icon.ContextMenuStrip?.Dispose();
        _icon.Dispose();
        _standbyIcon.Dispose();
        _monitoringIcon.Dispose();
    }
}
