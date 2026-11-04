package com.worknotice.alarm;
import android.content.Context;
import androidx.work.*;
import java.util.concurrent.TimeUnit;
public final class MonitoringStopWorker extends Worker {
    public MonitoringStopWorker(Context c,WorkerParameters p){super(c,p);}
    public static void enqueue(Context c){WorkManager.getInstance(c).enqueueUniqueWork("monitoring-stop",ExistingWorkPolicy.KEEP,new OneTimeWorkRequest.Builder(MonitoringStopWorker.class).setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).setBackoffCriteria(BackoffPolicy.EXPONENTIAL,15,TimeUnit.SECONDS).build());}
    @Override public Result doWork(){MonitoringStore s=new MonitoringStore(getApplicationContext());var pending=s.pending();if(pending==null||!"OFF".equals(pending.optString("mode")))return Result.success();try{new MonitoringClient(getApplicationContext()).retry();return Result.success();}catch(ApiClient.ApiException e){return AlarmPolicy.retryHttp(e.status)&&getRunAttemptCount()<8?Result.retry():Result.failure();}catch(Exception e){return getRunAttemptCount()<8?Result.retry():Result.failure();}}
}
