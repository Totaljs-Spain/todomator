mkdir -p .bundle

cd .bundle
cp -a ../controllers/ controllers
cp -a ../definitions/ definitions
cp -a ../modules/ modules
cp -a ../plugins/ plugins
cp -a ../schemas/ schemas
cp -a ../public/ public
cp -a ../views/ views
cp -a ../resources/ resources
rm resources/en.resource

# cd ..
total5 --bundle app.bundle
cp app.bundle ../--bundles--/app.bundle

cd ..
rm -rf .bundle
echo "DONE"