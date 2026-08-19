using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Media;

namespace Ferrum.WindowsFixture;

public static class Program
{
    [STAThread]
    public static void Main()
    {
        var app = new Application
        {
            ShutdownMode = ShutdownMode.OnMainWindowClose
        };

        var window = new Window
        {
            Title = "Ferrum Native Windows Fixture",
            Width = 520,
            Height = 340,
            WindowStartupLocation = WindowStartupLocation.CenterScreen,
            Background = Brushes.White
        };
        AutomationProperties.SetAutomationId(window, "FerrumWindow");

        var panel = new StackPanel
        {
            Margin = new Thickness(24)
        };

        var heading = new TextBlock
        {
            Text = "Ferrum Native Windows Fixture",
            FontSize = 22,
            Margin = new Thickness(0, 0, 0, 16)
        };
        AutomationProperties.SetAutomationId(heading, "Heading");

        var input = new TextBox
        {
            MinWidth = 280,
            Margin = new Thickness(0, 0, 0, 12)
        };
        AutomationProperties.SetAutomationId(input, "NameInput");
        AutomationProperties.SetName(input, "Name Input");

        var submit = new Button
        {
            Content = "Submit",
            Width = 120,
            Height = 36,
            HorizontalAlignment = HorizontalAlignment.Left,
            Margin = new Thickness(0, 0, 0, 12)
        };
        AutomationProperties.SetAutomationId(submit, "SubmitButton");
        AutomationProperties.SetName(submit, "Submit");

        var status = new TextBlock
        {
            Text = "idle",
            FontSize = 18,
            Margin = new Thickness(0, 0, 0, 12)
        };
        AutomationProperties.SetAutomationId(status, "StatusText");
        AutomationProperties.SetName(status, "idle");

        var toggle = new Button
        {
            Content = "Toggle details",
            Width = 120,
            Height = 36,
            HorizontalAlignment = HorizontalAlignment.Left
        };
        AutomationProperties.SetAutomationId(toggle, "ToggleButton");
        AutomationProperties.SetName(toggle, "Toggle details");

        var details = new TextBlock
        {
            Text = "details hidden",
            Visibility = Visibility.Collapsed,
            Margin = new Thickness(0, 12, 0, 0)
        };
        AutomationProperties.SetAutomationId(details, "DetailsText");
        AutomationProperties.SetName(details, "details hidden");

        submit.Click += (_, _) =>
        {
            var next = $"hello {input.Text}";
            status.Text = next;
            AutomationProperties.SetName(status, next);
        };

        toggle.Click += (_, _) =>
        {
            details.Visibility = details.Visibility == Visibility.Visible ? Visibility.Collapsed : Visibility.Visible;
        };

        panel.Children.Add(heading);
        panel.Children.Add(input);
        panel.Children.Add(submit);
        panel.Children.Add(status);
        panel.Children.Add(toggle);
        panel.Children.Add(details);
        window.Content = panel;
        app.Run(window);
    }
}
