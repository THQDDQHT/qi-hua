import { useEffect, useState } from "react";
import { createBrowserRouter, Navigate, Outlet, type RouteObject } from "react-router-dom";

import UserLayout from "@/layouts/user-layout";
import { appMode, type AppMode } from "@/lib/app-mode";
import { routesFor, type AppRouteId } from "@/lib/app-routes";
import AssetsPage from "@/pages/assets";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";
import ConfigPage from "@/pages/config";
import HomePage from "@/pages/home";
import ImagePage from "@/pages/image";
import NotFound from "@/pages/not-found";
import PromptsPage from "@/pages/prompts";
import VideoPage from "@/pages/video";

const routeElements: Record<AppRouteId, React.ReactNode> = {
    home: <HomePage />,
    image: <ImagePage />,
    video: <VideoPage />,
    assets: <AssetsPage />,
    prompts: <PromptsPage />,
    canvas: <CanvasPage />,
    "canvas-project": <CanvasProjectPage />,
    config: <ConfigPage />,
};

function PublicHomeRoute() {
    const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 767px)").matches);

    useEffect(() => {
        const media = window.matchMedia("(max-width: 767px)");
        const update = () => setMobile(media.matches);
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, []);

    return mobile ? <Navigate to="/image" replace /> : <HomePage />;
}

export function routeObjectsFor(mode: AppMode): RouteObject[] {
    return [
        {
            element: (
                <UserLayout>
                    <Outlet />
                </UserLayout>
            ),
            children: routesFor(mode).map((route) => ({
                path: route.path,
                element: route.id === "home" && mode === "public" ? <PublicHomeRoute /> : routeElements[route.id],
            })),
        },
        { path: "*", element: <NotFound /> },
    ];
}

export const router = createBrowserRouter(routeObjectsFor(appMode));
