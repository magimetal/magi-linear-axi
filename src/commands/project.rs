use crate::{
    cli::{Cli, ProjectCommand},
    commands::resource::{self, Kind},
};
pub fn execute(c: &Cli, x: ProjectCommand) -> Result<(), crate::error::AppError> {
    let (o, a) = match x {
        ProjectCommand::List(a) => ("list", a),
        ProjectCommand::View(a) => ("view", a),
        ProjectCommand::Create(a) => ("create", a),
        ProjectCommand::Update(a) => ("update", a),
        ProjectCommand::Delete(a) => ("delete", a),
    };
    resource::run(c, Kind::Project, o, a)
}
