# r4: cache use of each probe request, as the API reported it

Each cell: cache_read / cache_creation input tokens, then the API's cache_miss_reason (missed tokens).

| method | background | compact | midturn | parallel | text | thinking | tool |
|---|---|---|---|---|---|---|---|
| `file` | - | 10620 / 12239 system_changed (7255) | - | - | 12211 / 9944 messages_changed (5654) | - | - |
| `file2` | - | 10620 / 12190 system_changed (7255) | - | - | 12211 / 9901 messages_changed (5654) | - | - |
| `file3` | - | 10624 / 12276 system_changed (17440) | - | - | 12211 / 9944 messages_changed (5654) | - | - |
| `file4` | - | 10624 / 12305 system_changed (17440) | - | - | 12211 / 9749 messages_changed (5654) | - | - |
| `file5` | - | 10620 / 12429 system_changed (7255) | - | - | 12211 / 9678 messages_changed (5654) | - | - |
| `file6` | - | 10620 / 12234 system_changed (7255) | - | - | 12211 / 9754 messages_changed (5654) | - | - |
| `file7` | - | 10620 / 12234 system_changed (7255) | - | - | 12211 / 9678 messages_changed (5654) | - | - |
| `file8` | - | 10624 / 12193 system_changed (17440) | - | - | 12211 / 9716 messages_changed (5654) | - | - |
| `file9` | - | 10624 / 12242 system_changed (17440) | - | - | 12211 / 9754 messages_changed (5654) | - | - |
| `local` | 19128 / 2682  | 12213 / 9734 messages_changed (5692) | 18776 / 2737  | 18622 / 2942  | 12211 / 8956 messages_changed (5654) | 18589 / 6691  | 18636 / 2688  |
| `local2` | 19128 / 2682  | 12298 / 9744 system_changed (17440) | 18776 / 2732  | 18622 / 2942  | 12211 / 8956 messages_changed (5654) | 18589 / 6686  | 18636 / 2683  |
| `local3` | 19128 / 2682  | 12213 / 9744 messages_changed (5692) | 18776 / 2737  | 18622 / 2947  | 12211 / 8961 messages_changed (5654) | 18589 / 6691  | 18636 / 2693  |
| `local4` | - | 12213 / 9744 messages_changed (5692) | - | - | 12211 / 8956 messages_changed (5654) | - | - |
| `local5` | - | 12298 / 9744 system_changed (17440) | - | - | 12211 / 8956 messages_changed (5654) | - | - |
| `local6` | - | 12298 / 9744 system_changed (17440) | - | - | 12211 / 8956 messages_changed (5654) | - | - |
| `local7` | - | 12298 / 9744 system_changed (17440) | - | - | 12211 / 8961 messages_changed (5654) | - | - |
| `local8` | - | 12298 / 9744 system_changed (17440) | - | - | 12211 / 8956 messages_changed (5654) | - | - |
| `msg` | 10624 / 9433  | 10620 / 9015  | 10620 / 8958  | 10620 / 8838  | 10620 / 8845  | 10624 / 9681  | 10620 / 8956  |
| `msg-msgid,reqid,model,wire,toolresult,strcontent,system,extras` | 18761 / 3726 messages_changed (6266) | 10624 / 12388 system_changed (17440) | 18776 / 3459  | 18622 / 3778  | 12211 / 9792 messages_changed (5654) | 18589 / 7603  | 18636 / 3524  |
| `msg-msgid,reqid,turnpos,model,toolresult,strcontent,system,extras` | 18501 / 4080 messages_changed (6266) | 10624 / 12432 system_changed (17440) | 18776 / 3763  | 18622 / 3778  | 12211 / 9754 messages_changed (5654) | 18589 / 7532  | 18636 / 3496  |
| `msg-msgid,reqid,turnpos,model,wire,strcontent,system,extras` | 18761 / 3597 messages_changed (6266) | 10620 / 12112 system_changed (7255) | 18776 / 3568  | 18622 / 3783  | 12211 / 9754 messages_changed (5654) | 18589 / 7489  | 18636 / 3600  |
| `msg-msgid,reqid,turnpos,model,wire,toolresult,strcontent,extras` | 18761 / 3754 messages_changed (6266) | 18504 / 8028 messages_changed (5692) | 18776 / 3606  | 18622 / 3849  | 12211 / 9873 messages_changed (5654) | 18589 / 7636  | 18636 / 3562  |
| `msg-msgid,reqid,turnpos,model,wire,toolresult,strcontent,system` | 10620 / 9313 system_changed (7831) | 10624 / 9007  | 10620 / 8963 system_changed (7424) | 10620 / 9108 system_changed (7225) | 10624 / 8916 system_changed (17400) | 10624 / 9564 system_changed (17427) | 10624 / 9013 system_changed (17466) |
| `msg-msgid,reqid,turnpos,model,wire,toolresult,strcontent,system,extras` | 18761 / 3792 messages_changed (6266) | 10620 / 12351 system_changed (7255) | 18776 / 3416  | 18622 / 3702  | 12211 / 9754 messages_changed (5654) | 18589 / 7451  | 18636 / 3567  |
| `msg-msgid,reqid,turnpos,model,wire,toolresult,strcontent,system,extras,origin` | 19128 / 3556  | 10624 / 12310 system_changed (17440) | 18776 / 3606  | 18622 / 3664  | 12211 / 9792 messages_changed (5654) | 18589 / 7641  | 18636 / 3638  |
| `msg-msgid,reqid,turnpos,model,wire,toolresult,strcontent,system,extras@` | 18761 / 3868 messages_changed (6266) | 10624 / 12203 system_changed (17440) | 18776 / 3606  | 18622 / 3664  | 12211 / 9754 messages_changed (5654) | 18589 / 7560  | 18636 / 3562  |
| `msg-msgid,reqid,turnpos,model,wire,toolresult,system,extras` | 18761 / 3602 messages_changed (6266) | 10624 / 12159 system_changed (17440) | 18776 / 3335  | 18622 / 3783  | 12211 / 9982 messages_changed (5654) | 18589 / 7451  | 18636 / 3524  |
| `msg-msgid,reqid,turnpos,wire,toolresult,strcontent,system,extras` | 18761 / 3792 messages_changed (6266) | 10624 / 12203 system_changed (17440) | 18776 / 3573  | 18622 / 3740  | 12211 / 9835 messages_changed (5654) | 12215 / 10570 messages_changed (5678) | 18636 / 3448  |
| `msg-msgid,turnpos,model,wire,toolresult,strcontent,system,extras` | 18761 / 3650 messages_changed (6266) | 10620 / 12234 system_changed (7255) | 18776 / 3449  | 18622 / 3697  | 12211 / 9754 messages_changed (5654) | 18589 / 7565  | 18636 / 3605  |
| `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,origin,toolresult,wire,asstmeta,strcontent,system,extras` | 19128 / 3594  | 10624 / 12203 system_changed (17440) | 18776 / 3725  | 18622 / 3740  | 12211 / 9868 messages_changed (5654) | 18589 / 7560  | 18636 / 3486  |
| `msg-reqid,turnpos,model,wire,toolresult,strcontent,system,extras` | 18501 / 3968  | 10624 / 12388  | 18562 / 3747  | 18387 / 4047  | 12211 / 9868  | 12215 / 10684  | 18510 / 3643  |
| `raw` | 19128 / 3632  | 10620 / 12190 system_changed (7255) | 18776 / 3568  | 18622 / 3854  | 12211 / 9901 messages_changed (5654) | 18589 / 7370  | 18636 / 3372  |
| `raw@` | 19128 / 3480  | 10624 / 12193 system_changed (17440) | 18776 / 3497  | 18622 / 3692  | 12211 / 9830 messages_changed (5654) | 18589 / 7365  | 18636 / 3600  |
