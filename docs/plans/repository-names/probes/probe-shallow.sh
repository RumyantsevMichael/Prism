# P4: root commits of a full clone, a clone of a moved copy of the repository, and a shallow clone.
set -e
d=$(mktemp -d); cd $d
export HOME=$d GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=$d/gc; : > $d/gc
git init -q -b main origin && cd origin && git -c user.name=p -c user.email=p@x commit -q --allow-empty -m one && git -c user.name=p -c user.email=p@x commit -q --allow-empty -m two && cd ..
git clone -q --bare origin moved.git
git clone -q file://$d/origin full; git clone -q file://$d/moved.git movedclone; git clone -q --depth 1 file://$d/origin shallow
for c in full movedclone shallow; do echo "$c shallow=$(git -C $c rev-parse --is-shallow-repository) roots=$(git -C $c rev-list --max-parents=0 HEAD | tr '\n' ' ')"; done
git -C shallow fetch -q --unshallow; echo "after unshallow: shallow=$(git -C shallow rev-parse --is-shallow-repository) roots=$(git -C shallow rev-list --max-parents=0 HEAD)"
