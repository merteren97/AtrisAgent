import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useSettingsStore } from '@/stores/settings-store';
import { ShieldCheck, Activity } from 'lucide-react';

export function OnboardingModal() {
  const { hasSeenOnboarding, setHasSeenOnboarding, telemetryOptIn, setTelemetryOptIn } = useSettingsStore();

  const handleComplete = () => {
    setHasSeenOnboarding(true);
  };

  return (
    <Dialog open={!hasSeenOnboarding} onOpenChange={(open) => {
      if (!open) {
        // Force them to click "Get Started" to ensure they saw it
        // Or we can just let them close it and mark as seen.
        setHasSeenOnboarding(true);
      }
    }}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold tracking-tight">Welcome to AtrisAgent</DialogTitle>
          <DialogDescription className="text-muted-foreground mt-2">
            Before you begin your development journey, please review our privacy setup.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 py-6">
          <div className="flex items-start gap-4 p-4 rounded-lg bg-muted/50 border">
            <ShieldCheck className="w-6 h-6 text-primary mt-0.5" />
            <div className="space-y-1">
              <h4 className="font-semibold text-sm">Local-First & Secure</h4>
              <p className="text-sm text-muted-foreground">
                AtrisAgent runs entirely local on your machine. Your codebase, prompts, and context are never uploaded to any centralized servers without your explicit AI model requests.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-4 p-4 rounded-lg border">
            <Activity className="w-6 h-6 text-muted-foreground mt-0.5" />
            <div className="flex-1 space-y-1">
              <div className="flex items-center justify-between">
                <Label htmlFor="telemetry-opt-in" className="font-semibold text-sm cursor-pointer">
                  Share Anonymous Telemetry
                </Label>
                <Switch 
                  id="telemetry-opt-in" 
                  checked={telemetryOptIn}
                  onCheckedChange={setTelemetryOptIn}
                />
              </div>
              <p className="text-sm text-muted-foreground">
                Help us improve AtrisAgent by sending anonymous usage data (e.g., error rates, basic feature usage). No personal data or code is ever shared.
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={handleComplete} className="w-full">
            Get Started
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
