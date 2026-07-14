//! Newtype ids: the seams carry these, never bare strings, so a conversation
//! id cannot be passed where a message id belongs.

use serde::{Deserialize, Serialize};

macro_rules! id {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

id!(ConversationId);
id!(QueryId);
id!(TurnId);
id!(MessageId);
id!(ApprovalId);
id!(WorldId);
id!(InstanceId);
