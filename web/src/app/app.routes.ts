import { Routes } from '@angular/router';
import { DashboardComponent } from './dashboard.component';
import { SandboxesComponent } from './sandboxes.component';
import { BrowserComponent } from './browser.component';
import { MemoryComponent } from './memory.component';
import { UpstreamsComponent } from './upstreams.component';
import { ApprovalsComponent } from './approvals.component';
import { AuditComponent } from './audit.component';
import { ClientsComponent } from './clients.component';
import { SettingsComponent } from './settings.component';

export const routes: Routes = [
  { path: '', component: DashboardComponent },
  { path: 'sandboxes', component: SandboxesComponent },
  { path: 'browser', component: BrowserComponent },
  { path: 'memory', component: MemoryComponent },
  { path: 'upstreams', component: UpstreamsComponent },
  { path: 'approvals', component: ApprovalsComponent },
  { path: 'audit', component: AuditComponent },
  { path: 'clients', component: ClientsComponent },
  { path: 'settings', component: SettingsComponent },
  { path: '**', redirectTo: '' },
];
