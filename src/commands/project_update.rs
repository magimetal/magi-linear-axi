use crate::{
    cli::{Cli, ProjectUpdateCommand},
    commands::resource::{self, Kind},
};
pub fn execute(c: &Cli, x: ProjectUpdateCommand) -> Result<(), crate::error::AppError> {
    let (o, a) = match x {
        ProjectUpdateCommand::List(a) => ("list", a),
        ProjectUpdateCommand::Create(a) => ("create", a),
    };
    resource::run(c, Kind::ProjectUpdate, o, a)
}
