/*
 * The parts of Headlamp's plugin API this plugin uses. Headlamp provides them at runtime as
 * the `pluginLib` global (build.mjs maps the imports to it), so the plugin is built without
 * @kinvolk/headlamp-plugin and its ~1,300-package toolchain. Signatures follow
 * @kinvolk/headlamp-plugin 0.14 (frontend/src/plugin/registry.tsx, lib/k8s/api/v1/
 * clusterRequests.ts, components/common/*); re-check them when the Headlamp image is upgraded.
 */
declare module '@kinvolk/headlamp-plugin/lib' {
  import type { ComponentType } from 'react';

  export interface SidebarEntryProps {
    name: string;
    label: string;
    url?: string;
    parent?: string | null;
    icon?: string;
    sidebar?: string;
    useClusterURL?: boolean;
  }
  export function registerSidebarEntry(entry: SidebarEntryProps): void;

  export interface Route {
    path: string;
    name?: string;
    exact?: boolean;
    sidebar: string | null | { item: string | null; sidebar: string };
    useClusterURL?: boolean;
    noAuthRequired?: boolean;
    component: ComponentType;
  }
  export function registerRoute(route: Route): void;

  export namespace ApiProxy {
    /** A request to the current cluster's API server, with the signed-in person's credentials. */
    function request(path: string, params?: RequestInit & { timeout?: number }): Promise<any>;
  }
}

declare module '@kinvolk/headlamp-plugin/lib/CommonComponents' {
  import type { ReactNode } from 'react';

  export function SectionBox(props: {
    title?: ReactNode;
    headerProps?: { actions?: ReactNode[] };
    children?: ReactNode;
  }): JSX.Element;
  export function Loader(props: { title: string }): JSX.Element;
  export function StatusLabel(props: {
    status: 'success' | 'warning' | 'error' | '';
    title?: string;
    children?: ReactNode;
  }): JSX.Element;
  export function NameValueTable(props: { rows: { name: ReactNode; value?: ReactNode }[] }): JSX.Element;
  export function SimpleTable(props: {
    columns: { label: string; getter: (row: any) => ReactNode; sort?: boolean }[];
    data: any[] | null | undefined;
    emptyMessage?: string;
    errorMessage?: string | null;
  }): JSX.Element;
}
