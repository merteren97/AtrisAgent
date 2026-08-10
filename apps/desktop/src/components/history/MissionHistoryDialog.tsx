import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useMissionStore, MissionStatus } from '@/stores/mission-store';
import { Search, History, CheckCircle2, XCircle, AlertCircle, PlayCircle } from 'lucide-react';

interface MissionHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const getStatusIcon = (status: MissionStatus) => {
  switch (status) {
    case 'completed': return <CheckCircle2 className="w-4 h-4 text-success" />;
    case 'failed': return <XCircle className="w-4 h-4 text-destructive" />;
    case 'cancelled': return <XCircle className="w-4 h-4 text-muted-foreground" />;
    case 'running': return <PlayCircle className="w-4 h-4 text-primary" />;
    default: return <AlertCircle className="w-4 h-4 text-warning" />;
  }
};

const getStatusVariant = (status: MissionStatus) => {
  switch (status) {
    case 'completed': return 'success';
    case 'failed': return 'destructive';
    case 'cancelled': return 'secondary';
    case 'running': return 'default';
    default: return 'outline';
  }
};

export function MissionHistoryDialog({ open, onOpenChange }: MissionHistoryDialogProps) {
  const { missions, setActiveMission, activeMissionId } = useMissionStore();
  const [search, setSearch] = useState('');

  const filteredMissions = missions.filter((mission) => 
    mission.title.toLowerCase().includes(search.toLowerCase()) || 
    (mission.checkpointId && mission.checkpointId.toLowerCase().includes(search.toLowerCase()))
  );

  const handleRestore = (id: string) => {
    setActiveMission(id);
    // Ideally we would trigger a fetch for tasks here if the backend requires it.
    // For now, the prompt just says "sets activeMissionId in useMissionStore and loads its tasks".
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px] h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="w-5 h-5" />
            Mission History
          </DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input 
            placeholder="Search missions or checkpoint IDs..." 
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <ScrollArea className="flex-1 mt-4">
          <div className="space-y-3 pr-4">
            {filteredMissions.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground">
                No missions found.
              </div>
            ) : (
              filteredMissions.map((mission) => (
                <div 
                  key={mission.id} 
                  className={`flex flex-col gap-2 p-4 border rounded-lg transition-colors ${activeMissionId === mission.id ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <h4 className="font-medium text-sm">{mission.title}</h4>
                        <Badge variant={getStatusVariant(mission.status) as any} className="flex items-center gap-1.5 h-5 px-1.5 text-[10px]">
                          {getStatusIcon(mission.status)}
                          {mission.status}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        <span>{new Date(mission.createdAt).toLocaleString()}</span>
                        {mission.taskCount !== undefined && (
                          <span>• {mission.taskCount} tasks</span>
                        )}
                        {mission.checkpointId && (
                          <span className="font-mono bg-muted px-1 py-0.5 rounded text-[10px]">
                            {mission.checkpointId}
                          </span>
                        )}
                      </div>
                    </div>
                    
                    <Button 
                      size="sm" 
                      variant="secondary"
                      onClick={() => handleRestore(mission.id)}
                      disabled={activeMissionId === mission.id}
                    >
                      {activeMissionId === mission.id ? 'Active' : 'Restore Checkpoint'}
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
