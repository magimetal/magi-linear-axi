use crate::{
    cli::{Cli, DocumentCommand},
    commands::resource::{self, Kind},
};
pub fn execute(c: &Cli, x: DocumentCommand) -> Result<(), crate::error::AppError> {
    let (o, a) = match x {
        DocumentCommand::List(a) => ("list", a),
        DocumentCommand::View(a) => ("view", a),
        DocumentCommand::Create(a) => ("create", a),
        DocumentCommand::Update(a) => ("update", a),
        DocumentCommand::Delete(a) => ("delete", a),
    };
    resource::run(c, Kind::Document, o, a)
}
