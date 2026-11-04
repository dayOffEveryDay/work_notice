package com.worknotice.alarm;
import org.junit.Test;
import static org.junit.Assert.*;

public class FsiStatusTests {
    @Test public void sharedEligibilityMatchesOriginalPredicateExhaustively(){
        for(boolean declaration:new boolean[]{false,true})for(long savedPeriod:new long[]{-1,10,20})for(long period:new long[]{-1,0,10,20})
        for(long savedPair:new long[]{-1,100,200})for(long pair:new long[]{100,200})for(boolean alarm:new boolean[]{false,true})for(boolean permission:new boolean[]{false,true}){
            FsiStatus s=new FsiStatus(declaration,savedPeriod,period,savedPair,pair,alarm,permission);
            assertEquals(declaration&&period>0&&savedPeriod==period&&savedPair==pair&&alarm,s.enabled);
        }
    }
    @Test public void enabledHasExplicitStateAndButton(){FsiStatus s=new FsiStatus(true,10,10,100,100,true,true);assertTrue(s.display().startsWith("FSI 實驗：已啟用"));assertTrue(s.enableLabel().contains("已啟用"));assertTrue(s.disableLabel().contains("關閉"));assertTrue(s.reasons.isEmpty());}
    @Test public void permissionIsIndependentOfLocalEnabled(){FsiStatus s=new FsiStatus(true,10,10,100,100,true,false);assertTrue(s.enabled);assertTrue(s.display().contains("目前不能發送 FSI"));assertTrue(s.enableLabel().contains("前往系統授權"));}
    @Test public void grantAloneDoesNotEnable(){FsiStatus s=new FsiStatus(false,-1,10,-1,100,true,true);assertFalse(s.enabled);assertTrue(s.reasons.contains(FsiStatus.Reason.NOT_DECLARED));assertTrue(s.display().contains("系統授權不會自動啟用"));}
    @Test public void periodUpdateGivesSpecificReason(){FsiStatus s=new FsiStatus(true,10,20,100,100,true,true);assertFalse(s.enabled);assertTrue(s.declared);assertTrue(s.display().contains("警報啟用期間／設定已更新"));assertTrue(s.enableLabel().contains("重新確認"));assertTrue(s.disableLabel().contains("清除已失效"));}
    @Test public void pairedAndAlarmFailuresAreVisible(){FsiStatus s=new FsiStatus(true,10,10,100,200,false,true);assertTrue(s.reasons.contains(FsiStatus.Reason.PAIRING_CHANGED));assertTrue(s.reasons.contains(FsiStatus.Reason.ALARM_INACTIVE));assertFalse(s.enabled);}
    @Test public void missingRevisionExplainsNeedToSync(){FsiStatus s=new FsiStatus(true,10,-1,100,100,true,true);assertFalse(s.enabled);assertTrue(s.display().contains("請先同步設定"));}
    @Test public void sameRevisionRefreshDoesNotInvalidate(){FsiStatus before=new FsiStatus(true,10,10,100,100,true,true),after=new FsiStatus(true,10,10,100,100,true,true);assertEquals(before.display(),after.display());assertTrue(after.enabled);}
    @Test public void disabledAndExpiredAreDifferentExplanations(){FsiStatus closed=new FsiStatus(true,10,10,100,100,false,true,FsiStatus.AlarmProblem.CLOSED),expired=new FsiStatus(true,10,10,100,100,false,true,FsiStatus.AlarmProblem.EXPIRED);assertTrue(closed.display().contains("工作警報已關閉"));assertTrue(expired.display().contains("啟用期間已到期"));assertNotEquals(closed.display(),expired.display());}
}
