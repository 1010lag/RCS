package by.rcs.app;

import com.getcapacitor.BridgeActivity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel("rcs", "Смены и события RCS", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Изменения графика, биржа и напоминания");
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            channel.enableVibration(true);
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }
}
