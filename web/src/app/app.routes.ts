import { Routes } from '@angular/router';
import { DashboardComponent } from './dashboard.component';
import { UpstreamsComponent } from './upstreams.component';
import { ApprovalsComponent } from './approvals.component';
import { AuditComponent } from './audit.component';
import { ClientsComponent } from './clients.component';
import { SettingsComponent } from './settings.component';

export const routes: Routes = [
  { path: '', component: DashboardComponent },
  { path: 'upstreams', component: UpstreamsComponent },
  { path: 'approvals', component: ApprovalsComponent },
  { path: 'audit', component: AuditComponent },
  { path: 'clients', component: ClientsComponent },
  { path: 'settings', component: SettingsComponent },
  { path: '**', redirectTo: '' },
];
