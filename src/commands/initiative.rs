use crate::{
    cli::{Cli, InitiativeCommand},
    commands::resource::{self, Kind},
};
pub fn execute(c: &Cli, x: InitiativeCommand) -> Result<(), crate::error::AppError> {
    let (o, a) = match x {
        InitiativeCommand::List(a) => ("list", a),
        InitiativeCommand::View(a) => ("view", a),
        InitiativeCommand::Create(a) => ("create", a),
        InitiativeCommand::Update(a) => ("update", a),
        InitiativeCommand::Archive(a) => ("archive", a),
        InitiativeCommand::Unarchive(a) => ("unarchive", a),
        InitiativeCommand::Delete(a) => ("delete", a),
        InitiativeCommand::AddProject(a) => ("add-project", a),
        InitiativeCommand::RemoveProject(a) => ("remove-project", a),
    };
    resource::run(c, Kind::Initiative, o, a)
}
