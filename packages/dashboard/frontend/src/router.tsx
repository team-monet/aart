import { createContext, useContext, useEffect, useState } from "react";
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";

export interface Route {
  name: string;
  params: Record<string, string>;
}

export function parseRoute(path: string): Route {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) {
    return { name: "runs", params: {} };
  }
  
  if (segments[0] === "runs") {
    if (segments[1] === "trigger") {
      return { name: "runs-trigger", params: {} };
    }
    if (segments[1]) {
      return { name: "run-detail", params: { id: segments[1] } };
    }
    return { name: "runs", params: {} };
  }
  
  if (segments[0] === "workflows") {
    if (segments[1]) {
      return { name: "workflow-detail", params: { id: segments[1] } };
    }
    return { name: "workflows", params: {} };
  }

  if (segments[0] === "waiting-runs") {
    return { name: "waiting-runs", params: {} };
  }

  if (segments[0] === "flagged-runs") {
    return { name: "flagged-runs", params: {} };
  }

  if (segments[0] === "approvals") {
    return { name: "approvals", params: {} };
  }

  if (segments[0] === "corrections") {
    if (segments[1] === "new") {
      return { name: "corrections-new", params: {} };
    }
    return { name: "corrections", params: {} };
  }

  if (segments[0] === "evals") {
    if (segments[1] === "new") {
      return { name: "evals-new", params: {} };
    }
    return { name: "evals", params: {} };
  }

  if (segments[0] === "production") {
    return { name: "production", params: {} };
  }

  return { name: "runs", params: {} };
}

interface RouterContextType {
  path: string;
  navigate: (to: string) => void;
  query: URLSearchParams;
}

const RouterContext = createContext<RouterContextType | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(window.location.pathname);
  const [query, setQuery] = useState(new URLSearchParams(window.location.search));

  useEffect(() => {
    const handlePopState = () => {
      setPath(window.location.pathname);
      setQuery(new URLSearchParams(window.location.search));
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = (to: string) => {
    // split path and query if query exists
    const [pathPart, queryPart] = to.split("?");
    window.history.pushState(null, "", to);
    setPath(pathPart || "/");
    setQuery(new URLSearchParams(queryPart || ""));
  };

  return (
    <RouterContext.Provider value={{ path, navigate, query }}>
      {children}
    </RouterContext.Provider>
  );
}

export function useRouter() {
  const context = useContext(RouterContext);
  if (!context) throw new Error("useRouter must be used within RouterProvider");
  return context;
}

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  className?: string;
  children: ReactNode;
}

export function Link({ href, className, children, ...props }: LinkProps) {
  const { navigate } = useRouter();

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    navigate(href);
  };

  return (
    <a href={href} className={className} onClick={handleClick} {...props}>
      {children}
    </a>
  );
}
