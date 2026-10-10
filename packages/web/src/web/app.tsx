import * as React from "react";
import { Redirect, Route, Switch, useLocation } from "wouter";
import { Provider } from "./components/provider";
import { AgentFeedback } from "@runablehq/website-runtime";
import { AuthProvider, useAuth } from "./components/auth-provider";
import { Shell } from "./components/natex/shell";
import { Page, Card } from "./components/natex/page";
import { mayVisitAny, portalForRoles, rolesOfUser } from "./lib/permissions";

import Login from "./pages/login";
import Track from "./pages/track";
import OpsBoard from "./pages/ops/board";
import OpsParcels from "./pages/ops/parcels";
import OpsBook from "./pages/ops/book";
import OpsManifests from "./pages/ops/manifests";
import OpsHubReceipt from "./pages/ops/hub-receipt";
import OpsBagging from "./pages/ops/bagging";
import OpsLinehaul from "./pages/ops/linehaul";
import OpsInbound from "./pages/ops/inbound";
import OpsScanLog from "./pages/ops/scan-log";
import OpsExceptions from "./pages/ops/exceptions";
import OpsSyncConflicts from "./pages/ops/sync-conflicts";
import OpsServiceability from "./pages/ops/serviceability";
import OpsMerchants from "./pages/ops/merchants";
import OpsRunsheets from "./pages/ops/runsheets";
import OpsNdr from "./pages/ops/ndr";
import AdminDashboard from "./pages/admin/dashboard";
import AdminUsers from "./pages/admin/users";
import AdminMerchantUsers from "./pages/admin/merchant-users";
import AdminBranches from "./pages/admin/branches";
import AdminZones from "./pages/admin/zones";
import AdminRateCards from "./pages/admin/rate-cards";
import AdminSettings from "./pages/admin/settings";
import AdminTemplates from "./pages/admin/templates";
import AdminAudit from "./pages/admin/audit";
import AdminMonitor from "./pages/admin/monitor";
import AdminAwbBatches from "./pages/admin/awb-batches";
import SecurityPage from "./pages/security";
import FinanceOverview from "./pages/finance/overview";
import FinanceCod from "./pages/finance/cod-page";
import FinanceRemittances from "./pages/finance/remittances-page";
import FinanceInvoices from "./pages/finance/invoices-page";
import FinanceDisputes from "./pages/finance/disputes-page";
import HrEmployees from "./pages/hr/employees";
import HrPackages from "./pages/hr/packages";
import HrTimesheets from "./pages/hr/timesheets";
import HrLeave from "./pages/hr/leave";
import HrPayroll from "./pages/hr/payroll";
import MerchantDisputes from "./pages/merchant/disputes";
import MerchantStatement from "./pages/merchant/statement";
import MerchantAccount from "./pages/merchant/account";
import MerchantParcels from "./pages/merchant/parcels";
import MerchantDashboard from "./pages/merchant/dashboard";
import MerchantBook from "./pages/merchant/book";
import MerchantPickups from "./pages/merchant/pickups";
import MerchantTracking from "./pages/merchant/tracking";
import MerchantNdr from "./pages/merchant/ndr";
import FieldHome from "./pages/field/index";

/**
 * Routing. Every authenticated screen lives inside <Shell>; the only public
 * route is the OTP login.
 *
 * The role checks here shape navigation only — they stop a signed-in ops user
 * from landing on a finance URL and seeing an error page. Authorisation itself
 * is enforced server-side by the role gates in api/middleware/pipeline.ts and
 * the row-level scoping in each module service (§5). Nothing in this file
 * grants access to anything.
 */

function Authenticated({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const [location] = useLocation();

  if (!session) {
    const next = location !== "/" ? `?next=${encodeURIComponent(location)}` : "";
    return <Redirect to={`/login${next}`} replace />;
  }

  const roles = rolesOfUser(session.user);
  if (!mayVisitAny(roles, location)) {
    return <Redirect to={portalForRoles(roles).home} replace />;
  }

  return <Shell>{children}</Shell>;
}

/** A single authenticated route, wrapped in the shell and the role guard. */
function Portal({
  path,
  children,
}: {
  path: string;
  children: React.ReactNode;
}) {
  return (
    <Route path={path}>
      <Authenticated>{children}</Authenticated>
    </Route>
  );
}

function Landing() {
  const { session } = useAuth();
  if (!session) return <Redirect to="/login" replace />;
  return <Redirect to={portalForRoles(rolesOfUser(session.user)).home} replace />;
}

function NotFound() {
  return (
    <Page title="No such screen" description="This address does not belong to any NatEx portal.">
      <Card className="max-w-xl">
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Use the sidebar to reach a screen in your portal. If you followed a link here,
          it may point at a screen that belongs to a different role.
        </p>
      </Card>
    </Page>
  );
}

function Routes() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/login" component={Login} />

      {/* Public — no session, no shell. PDPA-minimised payload (§9). */}
      <Route path="/track" component={Track} />
      <Route path="/track/:awb" component={Track} />

      {/* Operations — Milestone 1, fully built */}
      <Portal path="/ops">
        <Redirect to="/ops/board" replace />
      </Portal>
      <Portal path="/ops/board">
        <OpsBoard />
      </Portal>
      <Portal path="/ops/parcels">
        <OpsParcels />
      </Portal>
      <Portal path="/ops/book">
        <OpsBook />
      </Portal>
      <Portal path="/ops/manifests">
        <OpsManifests />
      </Portal>
      <Portal path="/ops/hub-receipt">
        <OpsHubReceipt />
      </Portal>

      {/* Transport — Milestone 2: bagging, linehaul, hub-to-hub receipt, custody */}
      <Portal path="/ops/bagging">
        <OpsBagging />
      </Portal>
      <Portal path="/ops/linehaul">
        <OpsLinehaul />
      </Portal>
      <Portal path="/ops/inbound">
        <OpsInbound />
      </Portal>
      <Portal path="/ops/scan-log">
        <OpsScanLog />
      </Portal>
      <Portal path="/ops/exceptions">
        <OpsExceptions />
      </Portal>
      <Portal path="/ops/sync-conflicts">
        <OpsSyncConflicts />
      </Portal>

      {/* Last mile — Milestone 3: runsheets, NDR queue, returns */}
      <Portal path="/ops/runsheets">
        <OpsRunsheets />
      </Portal>
      <Portal path="/ops/ndr">
        <OpsNdr />
      </Portal>

      <Portal path="/ops/serviceability">
        <OpsServiceability />
      </Portal>
      <Portal path="/ops/merchants">
        <OpsMerchants />
      </Portal>

      {/* Administration — identity and routing reference data */}
      <Portal path="/admin">
        <Redirect to="/admin/dashboard" replace />
      </Portal>
      <Portal path="/admin/dashboard">
        <AdminDashboard />
      </Portal>
      <Portal path="/admin/users">
        <AdminUsers />
      </Portal>
      <Portal path="/admin/merchant-users">
        <AdminMerchantUsers />
      </Portal>
      <Portal path="/admin/branches">
        <AdminBranches />
      </Portal>
      <Portal path="/admin/zones">
        <AdminZones />
      </Portal>
      {/* Administration — Milestone 5: pricing, configuration, audit, monitoring */}
      <Portal path="/admin/rate-cards">
        <AdminRateCards />
      </Portal>
      <Portal path="/admin/settings">
        <AdminSettings />
      </Portal>
      <Portal path="/admin/templates">
        <AdminTemplates />
      </Portal>
      <Portal path="/admin/audit">
        <AdminAudit />
      </Portal>
      <Portal path="/admin/monitor">
        <AdminMonitor />
      </Portal>
      <Portal path="/admin/awb-batches">
        <AdminAwbBatches />
      </Portal>

      {/* Every signed-in role: own MFA state and sessions (§2) */}
      <Portal path="/security">
        <SecurityPage />
      </Portal>

      {/* Finance — Milestone 4: COD ledger, remittances, invoices, disputes */}
      <Portal path="/finance">
        <FinanceOverview />
      </Portal>
      <Portal path="/finance/cod">
        <FinanceCod />
      </Portal>
      <Portal path="/finance/alerts">
        <Redirect to="/finance/cod?tab=alerts" replace />
      </Portal>
      <Portal path="/finance/remittances">
        <FinanceRemittances />
      </Portal>
      <Portal path="/finance/invoices">
        <FinanceInvoices />
      </Portal>
      <Portal path="/finance/disputes">
        <FinanceDisputes />
      </Portal>

      {/* HR — employee records, payroll drafts and leave; Finance/Admin approve. */}
      <Portal path="/hr">
        <Redirect to="/hr/employees" replace />
      </Portal>
      <Portal path="/hr/employees"><HrEmployees /></Portal>
      <Portal path="/hr/packages"><HrPackages /></Portal>
      <Portal path="/hr/timesheets"><HrTimesheets /></Portal>
      <Portal path="/hr/leave"><HrLeave /></Portal>
      <Portal path="/hr/payroll"><HrPayroll /></Portal>

      {/* Merchant portal — Milestone 3: dashboard, booking, bulk CSV, pickups, tracking, NDR */}
      <Portal path="/merchant">
        <MerchantDashboard />
      </Portal>
      <Portal path="/merchant/book">
        <MerchantBook />
      </Portal>
      <Portal path="/merchant/pickups">
        <MerchantPickups />
      </Portal>
      <Portal path="/merchant/parcels">
        <MerchantParcels />
      </Portal>
      <Portal path="/merchant/tracking">
        <MerchantTracking />
      </Portal>
      <Portal path="/merchant/ndr">
        <MerchantNdr />
      </Portal>
      <Portal path="/merchant/disputes">
        <MerchantDisputes />
      </Portal>
      <Portal path="/merchant/statement">
        <MerchantStatement />
      </Portal>
      <Portal path="/merchant/account">
        <MerchantAccount />
      </Portal>

      {/* Field staff — the real work happens in the mobile app */}
      <Portal path="/field">
        <FieldHome />
      </Portal>

      <Route>
        <Authenticated>
          <NotFound />
        </Authenticated>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <Provider>
      <AuthProvider>
        <Routes />
      </AuthProvider>
      {/* Do not remove — off by default, activated by parent iframe via postMessage */}
      {import.meta.env.DEV && <AgentFeedback />}
    </Provider>
  );
}

export default App;
