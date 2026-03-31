import React, {Component} from 'react';
import {connect} from 'react-redux';
import {
    Row,
    Col,
    ControlLabel,
    Clearfix
} from 'react-bootstrap';
import {
    RaisedButton,
    TextField,
    CircularProgress,
    AutoComplete,
    DatePicker,
    Chip,
    IconButton
} from 'material-ui';
import {
    show, 
    upsert, 
    autocomplete_card, 
    autocomplete_entity, 
    autocomplete_category
} from '../../services/expense';
import CategoryIcon from '../common/icons/category';
import ClearIcon from 'material-ui/svg-icons/content/clear';
import forge from 'node-forge';

class ExpenseForm extends Component {
    state = {
        expense: {
            category: '',
            entity: '',
            date: new Date(),
            card: '',
            digest: '',
            amount: '',
        },
        cardDataSource: [],
        entityDataSource: [],
        categoryDataSource: [],
        isLoadingValues: false,
        isCardAutoCompleteVisible: true,
        isEntityAutoCompleteVisible: true,
        isCategoryAutoCompleteVisible: true
    };

    componentDidMount() {
        this._retrieveExpense();
    }

    _retrieveExpense = () => {
        const {id} = this.props.params;
        if (!id) {
            return;
        }
        show(id).success(res => {
            console.log(res); // Log the response data
            const expense = res.expense;
            this.setState({
                expense,
                isCardAutoCompleteVisible: !expense.card,
                isEntityAutoCompleteVisible: !expense.entity,
                isCategoryAutoCompleteVisible: !expense.category
            });
        });
    };

    handleChange = (key, value) => {
        const { expense } = this.state;
        const updatedExpense = { ...expense, [key]: value };
        this.setState({
            expense: { ...updatedExpense }
        });

        if (key != 'category') {
            // Calculate the digest
            const combinedData = updatedExpense.entity + updatedExpense.amount + updatedExpense.date + updatedExpense.card;
            console.log('Updating digest...');
            const md = forge.md.sha256.create();
            md.update(combinedData);
            const digest = md.digest().toHex();
            console.log('Digest:', digest);
            this.setState({
              expense: { ...updatedExpense, digest }
            });
        }
    };

    handleSubmit = event => {
        event.preventDefault();
        const { expense } = this.state;
        upsert(expense)
            .success(res => {
                location.hash = '#/expenses';
            })
            .progress(value => {
                this.setState({ progress: value });
            });
    };

    handleUpdateInput = (key, value) => {
        const { expense } = this.state;
        if (key === 'card') {
            autocomplete_card(value).success(res => {
                this.setState({
                    cardDataSource: res,
                    expense: {...expense, card: value },
                    isCardAutoCompleteVisible: true,
                }, () => this.updateDigest());
            });
        } else if (key === 'entity') {
            autocomplete_entity(value).success(res => {
                this.setState({
                    entityDataSource: res,
                    expense: {...expense, entity: value },
                    isEntityAutoCompleteVisible: true,
                }, () => this.updateDigest());
            });
        } else if (key === 'category') {
            autocomplete_category(value).success(res => {
                this.setState({
                    categoryDataSource: res,
                    expense: {...expense, category: value },
                    isCategoryAutoCompleteVisible: true,
                });
            });
        }
    };

    updateDigest = () => {
        console.log('Updating digest...');
        const { expense } = this.state;
        const combinedData = expense.entity + expense.amount + expense.date + expense.card;
        const md = forge.md.sha256.create();
        md.update(combinedData);
        const digest = md.digest().toHex();
        console.log('Digest:', digest);
        this.setState({
          expense: { ...expense, digest }
        });
    };

    handleClear = (key) => {
        const { expense } = this.state;
        this.setState({
            expense: { ...expense, [key]: '' },
            [`is${key.charAt(0).toUpperCase() + key.slice(1)}AutoCompleteVisible`]: true
        });
    };
    
    render() {
        const { isLoading } = this.props.app.main;
        const { 
            expense, 
            progress, 
            isLoadingValues, 
            cardDataSource, 
            entityDataSource, 
            categoryDataSource,
            isCardAutoCompleteVisible, 
            isEntityAutoCompleteVisible, 
            isCategoryAutoCompleteVisible 
        } = this.state;
    
        return (
            <div>
                <Row>
                    <Col sm={4}>
                        <h2>
                            <CategoryIcon/> &nbsp;Register Expense
                            <CircularProgress className={(isLoading || isLoadingValues) ? 'loading-spinner' : 'hidden'} size={36}/>
                        </h2>
                    </Col>
                    <Col sm={8}>
                        <RaisedButton href='#/expenses' className='pull-right' secondary={true} label='Back'/>
                    </Col>
                </Row>
                <hr/>
                <form onSubmit={this.handleSubmit}>
                    <Row>
                        <Col sm={12}>
                            <Col sm={6}>
                                <Row>
                                    <Col sm={3}>
                                        <ControlLabel>Category:</ControlLabel>
                                    </Col>
                                    <Col sm={8}>
                                        {isCategoryAutoCompleteVisible ? (
                                            <AutoComplete
                                                hintText="Category"
                                                dataSource={categoryDataSource}
                                                onUpdateInput={(val) => this.handleUpdateInput('category', val)}
                                                fullWidth={true}
                                                maxSearchResults={5}
                                                filter={AutoComplete.caseInsensitiveFilter}
                                                value={expense.category}
                                                onNewRequest={(chosenRequest, index) => this.handleChange('category', chosenRequest)}
                                            />
                                        ) : (
                                            <div style={{ display: 'flex', alignItems: 'center' }}>
                                                <TextField
                                                    hintText="Category"
                                                    fullWidth={true}
                                                    value={expense.category || ''}
                                                    onChange={(_, val) => this.handleChange('category', val)}
                                                />
                                                <IconButton onClick={() => this.handleClear('category')}>
                                                    <ClearIcon />
                                                </IconButton>
                                            </div>
                                        )}
                                    </Col>
                                </Row>
                                <Row>
                                    <Col sm={3}>
                                        <ControlLabel>Card:</ControlLabel>
                                    </Col>
                                    <Col sm={8}>
                                        {isCardAutoCompleteVisible ? (
                                            <AutoComplete
                                                hintText="CTT card"
                                                dataSource={cardDataSource}
                                                onUpdateInput={(val) => this.handleUpdateInput('card', val)}
                                                fullWidth={true}
                                                maxSearchResults={5}
                                                filter={AutoComplete.caseInsensitiveFilter}
                                                value={expense.card}
                                                onNewRequest={(chosenRequest, index) => this.handleChange('card', chosenRequest)}
                                            />
                                        ) : (
                                            <div style={{ display: 'flex', alignItems: 'center' }}>
                                                <TextField
                                                    hintText="CTT card"
                                                    fullWidth={true}
                                                    value={expense.card}
                                                    onChange={(_, val) => this.handleChange('card', val)}
                                                />
                                                <IconButton onClick={() => this.handleClear('card')}>
                                                    <ClearIcon />
                                                </IconButton>
                                            </div>
                                        )}
                                    </Col>
                                </Row>
                                <Row>
                                    <Col sm={3}>
                                        <ControlLabel>Entity:</ControlLabel>
                                    </Col>
                                    <Col sm={8}>
                                        {isEntityAutoCompleteVisible ? (
                                            <AutoComplete
                                                hintText="Lidl/Intermarché"
                                                dataSource={entityDataSource}
                                                onUpdateInput={(val) => this.handleUpdateInput('entity', val)}
                                                fullWidth={true}
                                                maxSearchResults={5}
                                                filter={AutoComplete.caseInsensitiveFilter}
                                                value={expense.entity}
                                                onNewRequest={(chosenRequest, index) => this.handleChange('entity', chosenRequest)}
                                            />
                                        ) : (
                                            <div style={{ display: 'flex', alignItems: 'center' }}>
                                                <TextField
                                                    hintText="Lidl/Intermarché"
                                                    fullWidth={true}
                                                    value={expense.entity}
                                                    onChange={(_, val) => this.handleChange('entity', val)}
                                                />
                                                <IconButton onClick={() => this.handleClear('entity')}>
                                                    <ClearIcon />
                                                </IconButton>
                                            </div>
                                        )}
                                    </Col>
                                </Row>
                                <Row>
                                    <Col sm={3}>
                                        <ControlLabel>Amount in EUR:</ControlLabel>
                                    </Col>
                                    <Col sm={8}>
                                        <TextField hintText='0.20' fullWidth={true} value={expense.amount || ''}
                                                   onChange={(_, val) => this.handleChange('amount', val)}/>
                                    </Col>                          
                                </Row>
                                <Row>
                                    <Col sm={3}>
                                        <ControlLabel>Digest:</ControlLabel>
                                    </Col>
                                    <Col sm={8}>
                                        <ControlLabel>{expense.digest || ''}</ControlLabel>
                                    </Col>
                                </Row>
                                <Row>
                                    <Col sm={3}>
                                        <ControlLabel>Date:</ControlLabel>
                                    </Col>
                                    <Col sm={8}>
                                        <DatePicker
                                            value={new Date(expense.date)}
                                            name='date'
                                            onChange={(_, val) => this.handleChange('date', val)}
                                            container="inline"
                                            mode="landscape"
                                            autoOk
                                            locale="pt-PT"
                                            DateTimeFormat={global.Intl.DateTimeFormat}
                                        />
                                    </Col>                          
                                </Row>
                            </Col>
                        </Col>
                    </Row>
                    <Col sm={4} className="text-left">
                        <br/>
                        <RaisedButton type='submit' primary={true} className='pull-right' label="Save"
                                      disabled={isLoading || isLoadingValues}/>
                    </Col>
                    <Clearfix />
                </form>
                <hr/>
            </div>
        );
    }    
}

export default connect(state => state)(ExpenseForm)
