package by.rcs.app;

import android.graphics.Color;
import android.os.Build;
import android.view.Window;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Appearance")
public class AppearancePlugin extends Plugin {
    @PluginMethod
    public void setTheme(PluginCall call) {
        final boolean dark = "dark".equals(call.getString("theme", "light"));
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            int background = Color.parseColor(dark ? "#18181c" : "#ffffff");
            window.getDecorView().setBackgroundColor(background);
            // Before edge-to-edge enforcement these bars have their own backgrounds.
            if (Build.VERSION.SDK_INT < 35) {
                window.setStatusBarColor(background);
                window.setNavigationBarColor(background);
            }
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
            controller.setAppearanceLightStatusBars(!dark);
            controller.setAppearanceLightNavigationBars(!dark);
            call.resolve();
        });
    }
}
