// INPUT: Trusted original Agent, official session-title getter and in-memory workspace listing.
// OUTPUT: Detached title/workspace metadata with explicit session-creation cwd and unknown worktree.
// POS: Read-only fixed-desktop collector; no history export, title refresh or routing authority.
type Agent=Readonly<{id:string;session:Readonly<{header?:Readonly<{cwd?:string}>}>}>;
type Services=Readonly<{getTitle:(session:unknown)=>Readonly<{title:string;source:Readonly<{kind:string}>}>|undefined;
 listWorkspaces:()=>readonly Readonly<{path:string;sessionIds:readonly string[]}>[]}>;
export function collectDshMetadata(agent:Agent,services:Services){
 const title=services.getTitle(agent.session);
 const workspaces=services.listWorkspaces().filter(workspace=>workspace.sessionIds.includes(agent.id));
 const source=title?.source.kind;
 const titleProvider=title?(source==='user'||source==='provider'||source==='fallback'?source:'host'):'unknown';
 return Object.freeze({title:title?.title??null,titleProvider,
  workspacePath:workspaces.length===1?workspaces[0]!.path:null,
  cwd:agent.session.header?.cwd??null,cwdSource:agent.session.header?.cwd?'session-creation' as const:'unknown' as const,
  worktreePath:null,clientSurface:'desktop' as const});
}
