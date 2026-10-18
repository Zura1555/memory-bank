import type { ReactElement, ReactNode } from "react";
import { Drawer } from "@base-ui/react/drawer";
import { Button } from "@base-ui/react/button";

export function WorkflowDrawer({ open, onOpenChange, trigger, title, description, finalFocus, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement;
  title: string;
  description: string;
  finalFocus?: () => HTMLElement | boolean | null;
  children: ReactNode;
}) {
  return <Drawer.Root open={open} onOpenChange={onOpenChange} swipeDirection="right">
    <Drawer.Trigger render={trigger} />
    <Drawer.Portal>
      <Drawer.Backdrop className="workflow-backdrop" />
      <Drawer.Viewport className="workflow-drawer-viewport">
        <Drawer.Popup className="workflow-drawer" finalFocus={finalFocus}>
          <div className="workflow-drawer-header">
            <div><Drawer.Title>{title}</Drawer.Title><Drawer.Description className="field-hint">{description}</Drawer.Description></div>
            <Drawer.Close render={<Button className="icon-button" aria-label={`Close ${title.toLowerCase()}`} />}>Close</Drawer.Close>
          </div>
          <Drawer.Content className="workflow-drawer-content">{children}</Drawer.Content>
          <div className="workflow-drawer-footer"><Drawer.Close render={<Button className="primary-button" />}>Done</Drawer.Close></div>
        </Drawer.Popup>
      </Drawer.Viewport>
    </Drawer.Portal>
  </Drawer.Root>;
}
