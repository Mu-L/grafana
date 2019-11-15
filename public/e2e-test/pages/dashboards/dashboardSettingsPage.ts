import { ClickablePageObjectType, TestPage } from '@grafana/toolkit/src/e2e';

export interface DashboardSettingsPage {
  deleteDashBoard: ClickablePageObjectType;
  variablesSection: ClickablePageObjectType;
  saveDashBoard: ClickablePageObjectType;
}

export const dashboardSettingsPage = new TestPage<DashboardSettingsPage>({
  pageObjects: {
    deleteDashBoard: 'Dashboard settings page delete dashboard button',
    variablesSection: 'Dashboard settings section Variables',
    saveDashBoard: 'Dashboard settings aside actions Save button',
  },
});
