use crate::{cli::Cli, config, error::AppError, output::Output};
use serde_json::{Value, json};
use std::{
    fs,
    io::{self, Read},
};

#[derive(Clone, Copy)]
pub enum Kind {
    Team,
    User,
    Project,
    ProjectUpdate,
    Cycle,
    Milestone,
    Initiative,
    InitiativeUpdate,
    Label,
    Document,
}

pub fn run(cli: &Cli, kind: Kind, op: &str, a: crate::cli::ResourceArgs) -> Result<(), AppError> {
    let cfg = config::Config::load(cli.endpoint.clone(), cli.workspace.clone())?;
    let client = crate::client::LinearClient::new(cfg.endpoint, config::api_key()?)?;
    let out = Output::new(cli.format.clone(), cli.full);
    let id = a.args.first().cloned();
    if matches!((kind, op), (Kind::Team, "id")) {
        println!("{}", id.unwrap_or_default());
        return Ok(());
    }
    if a.web || a.app {
        open_url(cli, kind, id.as_deref())?;
        return Ok(());
    }
    let vars = vars(&a)?;
    let (query, variables) = document(kind, op, id.as_deref(), vars)?;
    let value = if a.all && op == "list" {
        client.paginate(query, variables)?
    } else {
        client.query(query, variables)?
    };
    out.render(&value)
}

fn vars(a: &crate::cli::ResourceArgs) -> Result<Value, AppError> {
    let mut input = serde_json::Map::new();
    macro_rules! put {
        ($f:ident,$k:literal) => {
            if let Some(v) = &a.$f {
                input.insert($k.into(), v.clone().into());
            }
        };
    }
    put!(name, "name");
    put!(title, "title");
    put!(body, "body");
    put!(content, "content");
    put!(description, "description");
    put!(team, "teamId");
    put!(project, "projectId");
    put!(issue, "issueId");
    put!(status, "status");
    put!(health, "health");
    put!(owner, "ownerId");
    put!(target_date, "targetDate");
    if let Some(p) = &a.file {
        let mut s = String::new();
        fs::File::open(p)
            .map_err(|e| AppError::usage(e.to_string()))?
            .read_to_string(&mut s)
            .map_err(|e| AppError::usage(e.to_string()))?;
        input.insert("content".into(), s.into());
    }
    if a.stdin {
        let mut s = String::new();
        io::stdin()
            .read_to_string(&mut s)
            .map_err(|e| AppError::usage(e.to_string()))?;
        input.insert("content".into(), s.into());
    }
    let mut filter = serde_json::Map::new();
    if let Some(team) = &a.team {
        filter.insert("team".into(), json!({"id":{"eq":team}}));
    }
    if let Some(project) = &a.project {
        filter.insert("project".into(), json!({"id":{"eq":project}}));
    }
    Ok(
        json!({"id":a.args.first(),"input":input,"first":a.limit,"after":null,"filter":filter,"includeArchived":a.archived}),
    )
}
fn document(
    k: Kind,
    op: &str,
    _id: Option<&str>,
    mut v: Value,
) -> Result<(&'static str, Value), AppError> {
    normalize_variables(k, op, &mut v)?;
    let q = match (k, op) {
        (Kind::Team, "list") => {
            "query GetTeams($first:Int,$after:String){teams(first:$first,after:$after){nodes{id name key description icon color cyclesEnabled createdAt updatedAt archivedAt} pageInfo{hasNextPage endCursor}}}"
        }
        (Kind::Team, "create") => {
            "mutation CreateTeam($input:TeamCreateInput!){teamCreate(input:$input){success team{id name key}}}"
        }
        (Kind::Team, "delete") => "mutation DeleteTeam($id:String!){teamDelete(id:$id){success}}",
        (Kind::Team, "members") => {
            "query GetTeamMembers($id:String!,$first:Int,$after:String){team(id:$id){members(first:$first,after:$after){nodes{id name displayName email active} pageInfo{hasNextPage endCursor}}}}"
        }
        (Kind::Team, "states") => {
            "query GetWorkflowStates($id:String!){team(id:$id){states{nodes{id name type position}}}}"
        }
        (Kind::Team, "autolinks") => {
            "query GetTeamAutolinks($id:String!){team(id:$id){id key name}}"
        }
        (Kind::User, "list") => {
            "query GetOrganizationMembers($first:Int,$after:String){organization{members(first:$first,after:$after){nodes{id name displayName email active} pageInfo{hasNextPage endCursor}}}}"
        }
        (Kind::Project, "list") => {
            "query GetProjects($filter:ProjectFilter,$first:Int,$after:String){projects(filter:$filter,first:$first,after:$after){nodes{id name description slugId url status{name type color} lead{name displayName} priority health startDate targetDate} pageInfo{hasNextPage endCursor}}}"
        }
        (Kind::Project, "view") => {
            "query GetProjectDetails($id:String!){project(id:$id){id name description slugId url status{name type color} lead{name displayName} priority health startDate targetDate createdAt updatedAt}}"
        }
        (Kind::Project, "create") => {
            "mutation CreateProject($input:ProjectCreateInput!){projectCreate(input:$input){success project{id slugId name url}}}"
        }
        (Kind::Project, "update") => {
            "mutation UpdateProject($id:String!,$input:ProjectUpdateInput!){projectUpdate(id:$id,input:$input){success project{id slugId name url}}}"
        }
        (Kind::Project, "delete") => {
            "mutation DeleteProject($id:String!){projectDelete(id:$id){success entity{id name}}}"
        }
        (Kind::ProjectUpdate, "list") => {
            "query ListProjectUpdates($id:String!,$first:Int){project(id:$id){name projectUpdates(first:$first){nodes{id body health url createdAt user{name displayName}}}}}"
        }
        (Kind::ProjectUpdate, "create") => {
            "mutation CreateProjectUpdate($input:ProjectUpdateCreateInput!){projectUpdateCreate(input:$input){success projectUpdate{id body health url}}}"
        }
        (Kind::Cycle, "list") => {
            "query GetTeamCycles($id:String!){team(id:$id){cycles{nodes{id number name startsAt endsAt completedAt isActive isFuture isPast}}}}"
        }
        (Kind::Cycle, "view") => {
            "query GetCycleDetails($id:String!){cycle(id:$id){id number name description startsAt endsAt completedAt isActive isFuture isPast team{id key name}}}"
        }
        (Kind::Milestone, "list") => {
            "query GetProjectMilestones($projectId:String!){project(id:$projectId){projectMilestones{nodes{id name description targetDate sortOrder project{id name}}}}}"
        }
        (Kind::Milestone, "view") => {
            "query GetMilestoneDetails($id:String!){projectMilestone(id:$id){id name description targetDate sortOrder project{id name slugId url}}}"
        }
        (Kind::Milestone, "create") => {
            "mutation CreateProjectMilestone($input:ProjectMilestoneCreateInput!){projectMilestoneCreate(input:$input){success projectMilestone{id name targetDate}}}"
        }
        (Kind::Milestone, "update") => {
            "mutation UpdateProjectMilestone($id:String!,$input:ProjectMilestoneUpdateInput!){projectMilestoneUpdate(id:$id,input:$input){success projectMilestone{id name targetDate}}}"
        }
        (Kind::Milestone, "delete") => {
            "mutation DeleteProjectMilestone($id:String!){projectMilestoneDelete(id:$id){success}}"
        }
        (Kind::Initiative, "list") => {
            "query GetInitiatives($filter:InitiativeFilter,$includeArchived:Boolean){initiatives(filter:$filter,includeArchived:$includeArchived){nodes{id slugId name description status targetDate health color icon url archivedAt owner{id displayName}} pageInfo{hasNextPage endCursor}}}"
        }
        (Kind::Initiative, "view") => {
            "query GetInitiativeDetails($id:String!){initiative(id:$id){id slugId name description status targetDate health color icon url archivedAt owner{id name displayName} projects{nodes{id name}}}}"
        }
        (Kind::Initiative, "create") => {
            "mutation CreateInitiative($input:InitiativeCreateInput!){initiativeCreate(input:$input){success initiative{id slugId name url}}}"
        }
        (Kind::Initiative, "update") => {
            "mutation UpdateInitiative($id:String!,$input:InitiativeUpdateInput!){initiativeUpdate(id:$id,input:$input){success initiative{id slugId name url}}}"
        }
        (Kind::Initiative, "archive") => {
            "mutation ArchiveInitiative($id:String!){initiativeArchive(id:$id){success}}"
        }
        (Kind::Initiative, "unarchive") => {
            "mutation UnarchiveInitiative($id:String!){initiativeUnarchive(id:$id){success entity{id name url}}}"
        }
        (Kind::Initiative, "delete") => {
            "mutation DeleteInitiative($id:String!){initiativeDelete(id:$id){success}}"
        }
        (Kind::Initiative, "add-project") => {
            "mutation AddProjectToInitiative($input:InitiativeToProjectCreateInput!){initiativeToProjectCreate(input:$input){success initiativeToProject{id}}}"
        }
        (Kind::Initiative, "remove-project") => {
            "mutation RemoveProjectFromInitiative($id:String!){initiativeToProjectDelete(id:$id){success}}"
        }
        (Kind::InitiativeUpdate, "list") => {
            "query ListInitiativeUpdates($id:String!,$first:Int){initiative(id:$id){name initiativeUpdates(first:$first){nodes{id body health url createdAt user{name}}}}}"
        }
        (Kind::InitiativeUpdate, "create") => {
            "mutation CreateInitiativeUpdate($input:InitiativeUpdateCreateInput!){initiativeUpdateCreate(input:$input){success initiativeUpdate{id body health url}}}"
        }
        (Kind::Label, "list") => {
            "query GetIssueLabels($filter:IssueLabelFilter,$first:Int,$after:String){issueLabels(filter:$filter,first:$first,after:$after){nodes{id name description color team{key name}} pageInfo{hasNextPage endCursor}}}"
        }
        (Kind::Label, "create") => {
            "mutation CreateIssueLabel($input:IssueLabelCreateInput!){issueLabelCreate(input:$input){success issueLabel{id name color description}}}"
        }
        (Kind::Label, "delete") => {
            "mutation DeleteIssueLabel($id:String!){issueLabelDelete(id:$id){success}}"
        }
        (Kind::Document, "list") => {
            "query ListDocuments($filter:DocumentFilter,$first:Int){documents(filter:$filter,first:$first){nodes{id title slugId url updatedAt project{name slugId} issue{identifier title}} pageInfo{hasNextPage endCursor}}}"
        }
        (Kind::Document, "view") => {
            "query GetDocument($id:String!){document(id:$id){id title slugId content url createdAt updatedAt creator{name email} project{name slugId} issue{identifier title}}}"
        }
        (Kind::Document, "create") => {
            "mutation CreateDocument($input:DocumentCreateInput!){documentCreate(input:$input){success document{id slugId title url}}}"
        }
        (Kind::Document, "update") => {
            "mutation UpdateDocument($id:String!,$input:DocumentUpdateInput!){documentUpdate(id:$id,input:$input){success document{id slugId title url}}}"
        }
        (Kind::Document, "delete") => {
            "mutation DeleteDocument($id:String!){documentDelete(id:$id){success}}"
        }
        _ => return Err(AppError::usage("unsupported resource operation")),
    };
    Ok((q, v))
}
fn normalize_variables(k: Kind, op: &str, variables: &mut Value) -> Result<(), AppError> {
    let root = variables
        .as_object_mut()
        .ok_or_else(|| AppError::usage("invalid command variables"))?;
    let id = root.get("id").cloned().unwrap_or(Value::Null);
    let input = root
        .get_mut("input")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| AppError::usage("invalid command input"))?;

    if matches!(k, Kind::Project) {
        if let Some(team_id) = input.remove("teamId") {
            input.insert("teamIds".into(), json!([team_id]));
        }
        if let Some(status_id) = input.remove("status") {
            input.insert("statusId".into(), status_id);
        }
    }

    match (k, op) {
        (Kind::Milestone, "list") => {
            let project_id = input.remove("projectId").unwrap_or(id);
            root.insert("projectId".into(), project_id);
        }
        (Kind::Initiative, "add-project") => {
            input.insert("initiativeId".into(), id);
        }
        (Kind::InitiativeUpdate, "create") => {
            if let Some(initiative_id) = input.remove("issueId") {
                input.insert("initiativeId".into(), initiative_id);
            }
        }
        _ => {}
    }
    Ok(())
}

fn open_url(cli: &Cli, _: Kind, id: Option<&str>) -> Result<(), AppError> {
    let w = cli
        .workspace
        .as_deref()
        .ok_or_else(|| AppError::usage("--workspace required for browser opening"))?;
    let u = format!("https://linear.app/{w}/{}", id.unwrap_or(""));
    let s = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(&u).status()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .args(["/C", "start", &u])
            .status()
    } else {
        std::process::Command::new("xdg-open").arg(&u).status()
    };
    s.map_err(|e| AppError::usage(e.to_string()))?;
    Ok(())
}
