using System;
using System.Threading.Tasks;
using System.Windows.Input;

namespace WorkNoticeAgent.App;

public sealed class AsyncCommand(Func<Task> execute, Action<Exception> failed, Func<bool>? canExecute = null) : ICommand
{
    private bool _running;
    public event EventHandler? CanExecuteChanged;
    public bool CanExecute(object? parameter) => !_running && (canExecute?.Invoke() ?? true);
    public async void Execute(object? parameter)
    {
        if (!CanExecute(parameter)) return;
        _running = true;
        Raise();
        try { await execute(); }
        catch (Exception ex) { failed(ex); }
        finally { _running = false; Raise(); }
    }
    public void Raise() => CanExecuteChanged?.Invoke(this, EventArgs.Empty);
}
