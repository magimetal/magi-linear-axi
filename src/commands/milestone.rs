use crate::{
    cli::{Cli, MilestoneCommand},
    commands::resource::{self, Kind},
};
pub fn execute(c: &Cli, x: MilestoneCommand) -> Result<(), crate::error::AppError> {
    let (o, a) = match x {
        MilestoneCommand::List(a) => ("list", a),
        MilestoneCommand::View(a) => ("view", a),
        MilestoneCommand::Create(a) => ("create", a),
        MilestoneCommand::Update(a) => ("update", a),
        MilestoneCommand::Delete(a) => ("delete", a),
    };
    resource::run(c, Kind::Milestone, o, a)
}
