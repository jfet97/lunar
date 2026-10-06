import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { useLogoutServerAuth } from "@/data/server-auth";
import { getApiErrorMessage } from "@/lib/api-errors";

export function ServerLogoutButton({ serverName }: { serverName: string }) {
  const { mutate, isPending } = useLogoutServerAuth();
  const { toast } = useToast();

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={isPending}
      aria-label={`Log out of ${serverName}`}
      title="Clear saved authentication and sign in again"
      onClick={(event) => {
        event.stopPropagation();
        mutate(
          { serverName },
          {
            onSuccess: () =>
              toast({
                title: `Logged out of ${serverName}`,
                description:
                  "Saved authentication cleared. Authenticate again to reconnect.",
              }),
            onError: (error) =>
              toast({
                title: `Failed to log out of ${serverName}`,
                description: getApiErrorMessage(error, "Please try again."),
                variant: "destructive",
              }),
          },
        );
      }}
    >
      <LogOut className="size-4" />
      {isPending ? "Logging out..." : "Logout"}
    </Button>
  );
}
