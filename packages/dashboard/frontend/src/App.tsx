import { RouterProvider, useRouter, parseRoute, Link } from "./router";
import { RunsPage } from "./pages/RunsPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { WorkflowsPage } from "./pages/WorkflowsPage";
import { ActivityFeedPage } from "./pages/ActivityFeedPage";
import { WaitingRunsPage } from "./pages/WaitingRunsPage";
import { FlaggedRunsPage } from "./pages/FlaggedRunsPage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { CorrectionsPage } from "./pages/CorrectionsPage";
import { EvalsPage } from "./pages/EvalsPage";
import { ProductionPage } from "./pages/ProductionPage";
import {
  Play,
  GitBranch,
  Clock,
  AlertTriangle,
  CheckSquare,
  FileEdit,
  Activity,
  Rss,
  Server,
  Terminal,
  ShieldCheck
} from "lucide-react";

function Sidebar() {
  const { path } = useRouter();
  const activeRoute = parseRoute(path).name;

  const links = [
    // V2 Wave 2A (AMENDMENTS.md A66) — placed first: the activity feed is
    // the cross-entity "what's happening right now" view (every lifecycle
    // event, live), the visible payoff of the VISIBILITY SYMMETRY vision
    // this slice ships. Rss (not Activity — that icon is already this
    // sidebar's own Evaluation Suites entry, below).
    { name: "activity", label: "Activity Feed", path: "/activity", icon: Rss },
    { name: "runs", label: "Workflow Runs", path: "/runs", icon: Play },
    { name: "workflows", label: "Workflows Spec", path: "/workflows", icon: GitBranch },
    { name: "waiting-runs", label: "Waiting Runs", path: "/waiting-runs", icon: Clock },
    { name: "flagged-runs", label: "Flagged Runs", path: "/flagged-runs", icon: AlertTriangle },
    { name: "approvals", label: "Approvals Queue", path: "/approvals", icon: CheckSquare },
    { name: "corrections", label: "Corrections Queue", path: "/corrections", icon: FileEdit },
    { name: "evals", label: "Evaluation Suites", path: "/evals", icon: Activity },
    { name: "production", label: "Production Ops", path: "/production", icon: Server },
  ];

  return (
    <aside className="w-64 bg-zinc-950 border-r border-zinc-900 flex flex-col h-screen sticky top-0 shrink-0">
      <div className="p-6 border-b border-zinc-900 flex items-center gap-2.5">
        <ShieldCheck className="h-6 w-6 text-primary" />
        <div>
          <span className="font-bold text-zinc-100 tracking-tight text-md">AART Governance</span>
          <div className="text-[10px] text-zinc-500 font-mono tracking-wider font-semibold">DASHBOARD CONTROL</div>
        </div>
      </div>
      
      <nav className="flex-1 px-4 py-6 space-y-1 overflow-y-auto">
        {links.map((link) => {
          const Icon = link.icon;
          // check if link matches activeRoute prefix or exact match
          const isActive = 
            activeRoute === link.name || 
            (link.name === "runs" && activeRoute === "run-detail") ||
            (link.name === "workflows" && activeRoute === "workflow-detail") ||
            (link.name === "corrections" && activeRoute === "corrections-new");

          return (
            <Link
              key={link.path}
              href={link.path}
              className={`flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-all ${
                isActive
                  ? "bg-zinc-900 text-zinc-100 font-semibold border-l-2 border-primary pl-2.5"
                  : "text-zinc-400 hover:bg-zinc-900/40 hover:text-zinc-200"
              }`}
            >
              <Icon className={`h-4 w-4 ${isActive ? "text-primary" : "text-zinc-500"}`} />
              {link.label}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-zinc-900 flex items-center gap-2 text-xs text-zinc-500 font-mono">
        <Terminal className="h-3.5 w-3.5" />
        <span>v0.1.0-alpha (mac)</span>
      </div>
    </aside>
  );
}

function MainContent() {
  const { path } = useRouter();
  const route = parseRoute(path);

  const renderPage = () => {
    switch (route.name) {
      case "activity":
        return <ActivityFeedPage />;
      case "runs":
      case "runs-trigger":
        return <RunsPage />;
      case "run-detail":
        return <RunDetailPage id={route.params.id || ""} />;
      case "workflows":
        return <WorkflowsPage />;
      case "workflow-detail":
        return <WorkflowsPage id={route.params.id || ""} />;
      case "waiting-runs":
        return <WaitingRunsPage />;
      case "flagged-runs":
        return <FlaggedRunsPage />;
      case "approvals":
        return <ApprovalsPage />;
      case "corrections":
        return <CorrectionsPage />;
      case "corrections-new":
        return <CorrectionsPage isNewForm={true} />;
      case "evals":
      case "evals-new":
        return <EvalsPage />;
      case "production":
        return <ProductionPage />;
      default:
        return <RunsPage />;
    }
  };

  return (
    <main className="flex-1 bg-zinc-900/20 min-h-screen p-8 text-zinc-100 overflow-y-auto">
      <div className="max-w-7xl mx-auto">
        {renderPage()}
      </div>
    </main>
  );
}

export default function App() {
  return (
    <RouterProvider>
      <div className="flex min-h-screen bg-zinc-950 text-zinc-100">
        <Sidebar />
        <MainContent />
      </div>
    </RouterProvider>
  );
}
