package com.worknotice.alarm;
import java.util.Locale;

public final class AlarmModeUi {
    private AlarmModeUi() { }
    public static final class InputError extends IllegalArgumentException {
        public final boolean hours;
        InputError(boolean hours,String text){super(text);this.hours=hours;}
    }
    private static int number(String value,boolean hours){
        String text=value==null?"":value.trim();if(text.isEmpty())return 0;
        try {int n=Integer.parseInt(text);if(n<0||n>(hours?24:59))throw new NumberFormatException();return n;}
        catch(NumberFormatException e){throw new InputError(hours,hours?"小時請輸入 0～24":"分鐘請輸入 0～59");}
    }
    public static int parse(String hours,String minutes){
        int h=number(hours,true),m=number(minutes,false);
        if(h==0&&m==0)throw new InputError(false,"預約延遲至少 1 分鐘；空白欄位視為 0");
        if(h*60+m>1440)throw new InputError(true,"預約最多 24 小時後開始；24 小時時分鐘需為 0");
        return AlarmPolicy.durationMinutes(h,m);
    }
    public static String remaining(long millis){long seconds=Math.max(0,(millis+999)/1000);return String.format(Locale.ROOT,"%02d:%02d:%02d",seconds/3600,seconds/60%60,seconds%60);}
    public static String failure(Exception error){
        if(error instanceof AlarmSettingsSave.Unconfirmed)return "伺服器可能已儲存，但讀回確認失敗。尚未確認成功；請重新整理，勿重複延長倒數。";
        if(error instanceof ApiClient.ApiException){int code=((ApiClient.ApiException)error).status;return switch(code){
            case 401,403 -> "配對授權已失效或被拒絕，未確認儲存；請檢查配對狀態。";
            case 400 -> "伺服器拒絕設定，請檢查時間與啟用模式。";
            case 429 -> "請求過於頻繁，請稍後重試。";
            default -> "伺服器回應 HTTP "+code+"，未確認儲存成功。";
        };}
        return switch(AckFailure.classify(error)){
            case DNS -> "無法解析伺服器位址，請檢查網路。";
            case TLS -> "安全連線驗證失敗，未確認儲存。";
            case TIMEOUT -> "連線逾時，儲存結果未確認；請先重新整理。";
            case NETWORK_IO -> "網路傳輸失敗，儲存結果未確認；請先重新整理。";
            case RESPONSE_JSON -> "伺服器回應格式錯誤，未確認儲存。";
            case LOCAL_SECURITY -> "安全儲存或權限錯誤，未確認儲存。";
            default -> "本機設定處理失敗，未確認儲存；請重試。";
        };
    }
}
