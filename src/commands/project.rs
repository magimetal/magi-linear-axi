use crate::{
    cli::{Cli, ProjectCommand},
    commands::resource::{self, Kind},
};
pub fn execute(c: &Cli, x: ProjectCommand) -> Result<(), crate::error::AppError> {
    match x {
        ProjectCommand::View(a) => {
            resource::run_with_fields(c, Kind::Project, "view", a.resource, a.fields)
        }
        ProjectCommand::List(a) => resource::run(c, Kind::Project, "list", a),
        ProjectCommand::Create(a) => resource::run(c, Kind::Project, "create", a),
        ProjectCommand::Update(a) => resource::run(c, Kind::Project, "update", a),
        ProjectCommand::Delete(a) => resource::run(c, Kind::Project, "delete", a),
    }
}
