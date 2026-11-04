package com.worknotice.alarm;
import java.util.ArrayList;
import java.util.List;

/** One local eligibility definition for UI and the existing FCM enabled() gate. */
public final class FsiStatus {
    public enum Reason { NOT_DECLARED, PERIOD_UNAVAILABLE, PERIOD_CHANGED, PAIRING_CHANGED, ALARM_INACTIVE }
    public enum AlarmProblem { UNKNOWN, CLOSED, EXPIRED, SETTINGS_UNAVAILABLE, CREDENTIAL_UNAVAILABLE }
    public final AlarmProblem alarmProblem;
    public final boolean declared, periodValid, pairingValid, alarmEnabled, enabled, granted;
    public final List<Reason> reasons;
    public FsiStatus(boolean declared,long savedPeriod,long currentPeriod,long savedPairing,long currentPairing,boolean alarmEnabled,boolean granted){
        this(declared,savedPeriod,currentPeriod,savedPairing,currentPairing,alarmEnabled,granted,AlarmProblem.UNKNOWN);
    }
    public FsiStatus(boolean declared,long savedPeriod,long currentPeriod,long savedPairing,long currentPairing,boolean alarmEnabled,boolean granted,AlarmProblem alarmProblem){
        this.alarmProblem=alarmProblem;
        this.declared=declared;this.periodValid=currentPeriod>0&&savedPeriod==currentPeriod;
        this.pairingValid=savedPairing==currentPairing;this.alarmEnabled=alarmEnabled;this.granted=granted;
        ArrayList<Reason> failures=new ArrayList<>();
        if(!declared)failures.add(Reason.NOT_DECLARED);
        if(currentPeriod<=0)failures.add(Reason.PERIOD_UNAVAILABLE);
        else if(declared&&!periodValid)failures.add(Reason.PERIOD_CHANGED);
        if(declared&&!pairingValid)failures.add(Reason.PAIRING_CHANGED);
        if(!alarmEnabled)failures.add(Reason.ALARM_INACTIVE);
        reasons=java.util.Collections.unmodifiableList(failures);
        enabled=declared&&periodValid&&pairingValid&&alarmEnabled;
    }
    public String display(){
        StringBuilder text=new StringBuilder("FSI 實驗：").append(enabled?"已啟用":"未啟用");
        if(!enabled)for(Reason reason:reasons)text.append("\n原因：").append(switch(reason){
            case NOT_DECLARED -> "尚未宣告緊急用途，或已關閉實驗";
            case PERIOD_UNAVAILABLE -> "缺少有效的警報啟用期間，請先同步設定";
            case PERIOD_CHANGED -> "警報啟用期間／設定已更新，請重新確認緊急用途";
            case PAIRING_CHANGED -> "配對世代已變更，請重新確認緊急用途";
            case ALARM_INACTIVE -> switch(alarmProblem){
                case CLOSED -> "原有工作警報已關閉，請先啟用工作警報";
                case EXPIRED -> "倒數警報啟用期間已到期，請重新設定期間並確認緊急用途";
                case SETTINGS_UNAVAILABLE -> "警報設定尚未同步，或手機重啟後已失效，請重新整理";
                case CREDENTIAL_UNAVAILABLE -> "未配對或安全儲存的配對憑證不可讀，請先檢查配對狀態";
                case UNKNOWN -> "原有工作警報未啟用，請查看上方警報狀態";
            };
        });
        text.append("\n緊急用途宣告：").append(declared?"已儲存":"未宣告／已清除")
            .append("\n宣告適用目前期間：").append(declared&&periodValid&&pairingValid?"是":"否")
            .append("\n原有工作警報：").append(alarmEnabled?"啟用中":"未啟用／已到期")
            .append("\n系統 FSI 授權：").append(granted?"允許":"未允許");
        if(!granted)text.append("\n目前不能發送 FSI：請由系統設定允許授權；一般備援仍保留。");
        else if(!enabled)text.append("\n系統授權不會自動啟用 App 內實驗。");
        else text.append("\nApp 與系統授權條件均成立；事件、優先級與通知頻道仍需通過檢查，不保證響鈴。");
        return text.toString();
    }
    public String enableLabel(){if(enabled)return granted?"全螢幕實驗已啟用（檢查系統授權）":"全螢幕實驗已啟用（前往系統授權）";return declared?"重新確認緊急用途並啟用實驗":"宣告緊急用途並啟用全螢幕實驗";}
    public String disableLabel(){return enabled?"關閉全螢幕實驗（不停止目前響鈴）":declared?"清除已失效的緊急用途宣告":"全螢幕實驗未啟用";}
}
